import { kn_expand_node, kn_calxy } from "./jstree";
import reduceMaxOrMin from "./reduceMaxOrMin";
import { processMetadataFile } from "./processNewick";
import type { StatusMessage } from "../types/backend";
import type {
  AlifeFile,
  MetadataFile,
  ProcessedTree,
} from "../types/newick";

const emptyList: any[] = [];

/**
 * Parse an ancestor_list value like "[0]", "[none]", "[0,1]", "[]", or ""
 * into an array of integer ancestor IDs. Returns an empty array for root nodes.
 */
function parseAncestorList(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];
  // Strip brackets
  const inner = trimmed.replace(/^\[|\]$/g, "").trim();
  if (!inner || inner.toLowerCase() === "none") return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== "none")
    .map((s) => {
      const n = parseInt(s, 10);
      if (isNaN(n)) throw new Error(`Invalid ancestor id: "${s}"`);
      return n;
    });
}

/**
 * Parse an ancestor_id value like "0", "none", "", or undefined
 * into an ancestor ID or null for root nodes.
 */
function parseAncestorId(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return null;
  const n = parseInt(trimmed, 10);
  if (isNaN(n)) return null;
  return n;
}

/**
 * Resolve the single parent ID for a row, given parsed metadata fields.
 * Returns null for root nodes.
 *
 * Prefers ancestor_id when present, falls back to ancestor_list.
 * For ancestor_list with multiple parents, uses only the first (trees only).
 */
function resolveParentId(
  row: Record<string, string>,
  hasAncestorId: boolean,
  hasAncestorList: boolean
): number | null {
  if (hasAncestorId) {
    const val = row["meta_ancestor_id"] ?? "";
    return parseAncestorId(val);
  }
  if (hasAncestorList) {
    const val = row["meta_ancestor_list"] ?? "";
    const ancestors = parseAncestorList(val);
    return ancestors.length > 0 ? ancestors[0] : null;
  }
  return null;
}

/**
 * Shared tree-building logic for ALife standard data.
 * Takes pre-parsed data (same format as processMetadataFile output) and
 * builds a ProcessedTree. Used by both CSV/TSV and Parquet paths.
 */
export async function buildAlifeTreeFromParsedData(
  parsedMap: Map<string, Record<string, string>>,
  headers: string[],
  ladderize: boolean | undefined,
  sendStatusMessage: (msg: StatusMessage) => void
): Promise<ProcessedTree> {
  // Determine which column is which
  const col0 = headers[0];
  const otherHeaders = headers.slice(1);
  const hasAncestorId = col0 === "ancestor_id" || otherHeaders.includes("ancestor_id");
  const hasAncestorList = col0 === "ancestor_list" || otherHeaders.includes("ancestor_list");
  const hasOriginTime = col0 === "origin_time" || otherHeaders.includes("origin_time");

  if (!hasAncestorId && !hasAncestorList) {
    sendStatusMessage({
      error:
        "ALife data must have an 'ancestor_list' or 'ancestor_id' column",
    });
    throw new Error(
      "ALife data must have an 'ancestor_list' or 'ancestor_id' column"
    );
  }

  // Build rows from the parsed map.
  // The map key is column 0's value; the map value has meta_<col> for other columns.
  // Reconstruct a full-row object for each entry with the original column names.
  const rows: { id: number; fields: Record<string, string> }[] = [];
  for (const [keyValue, metaObj] of parsedMap) {
    if (!keyValue && !metaObj) continue;

    // Reconstruct full row: column 0 value + all meta_ values
    const fields: Record<string, string> = { ...metaObj };
    // Add column 0 back with its meta_ prefix for uniform access
    fields["meta_" + col0] = keyValue;

    // Determine the id
    let idStr: string;
    if (col0 === "id") {
      idStr = keyValue;
    } else {
      idStr = fields["meta_id"] ?? "";
    }
    if (!idStr) continue;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) continue;

    rows.push({ id, fields });
  }

  if (rows.length === 0) {
    sendStatusMessage({ error: "ALife data contains no valid data rows" });
    throw new Error("ALife data contains no valid data rows");
  }

  sendStatusMessage({ message: "Building tree structure" });

  // Build lookup: id -> row
  const rowById = new Map<number, Record<string, string>>();
  for (const row of rows) {
    rowById.set(row.id, row.fields);
  }

  // Build jstree-compatible nodes
  interface JsTreeNode {
    parent: JsTreeNode | null;
    child: JsTreeNode[];
    name: string;
    meta: string;
    d: number;
    hl: boolean;
    hidden: boolean;
    num_tips?: number;
    alifeId: number;
    [key: string]: any;
  }

  const nodeById = new Map<number, JsTreeNode>();
  for (const row of rows) {
    const node: JsTreeNode = {
      parent: null,
      child: [],
      name: String(row.id),
      meta: "",
      d: 1.0,
      hl: false,
      hidden: false,
      alifeId: row.id,
    };

    // Attach metadata columns to node
    const fields = row.fields;
    for (const [key, value] of Object.entries(fields)) {
      if (
        key === "meta_ancestor_list" ||
        key === "meta_ancestor_id" ||
        key === "meta_id"
      ) {
        continue; // tree-structure columns, not user metadata
      }
      node[key] = value;
    }

    nodeById.set(row.id, node);
  }

  // Wire parent-child relationships
  const rootNodes: JsTreeNode[] = [];
  for (const row of rows) {
    const node = nodeById.get(row.id)!;
    const parentId = resolveParentId(row.fields, hasAncestorId, hasAncestorList);

    if (parentId === null) {
      rootNodes.push(node);
    } else {
      const parentNode = nodeById.get(parentId);
      if (parentNode) {
        node.parent = parentNode;
        parentNode.child.push(node);
      } else {
        // Parent not found in data - treat as root
        rootNodes.push(node);
      }
    }
  }

  if (rootNodes.length === 0) {
    sendStatusMessage({ error: "ALife data has no root node (no node without an ancestor)" });
    throw new Error("ALife data has no root node");
  }

  // Determine the root
  let root: JsTreeNode;
  if (rootNodes.length === 1) {
    root = rootNodes[0];
  } else {
    // Multiple roots - create synthetic root to connect them
    root = {
      parent: null,
      child: rootNodes,
      name: "synthetic_root",
      meta: "",
      d: 0,
      hl: false,
      hidden: false,
      alifeId: -1,
    };
    for (const r of rootNodes) {
      r.parent = root;
    }
  }

  // Compute branch distances from origin_time if available
  if (hasOriginTime) {
    const getOriginTime = (node: JsTreeNode): number => {
      const fields = rowById.get(node.alifeId);
      if (!fields) return 0;
      const val = fields["meta_origin_time"] ?? "0";
      const t = parseFloat(val);
      return isNaN(t) ? 0 : t;
    };

    // Set distances: d = this.origin_time - parent.origin_time
    const stack: JsTreeNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.parent && node.alifeId !== -1) {
        const parentTime = getOriginTime(node.parent);
        const nodeTime = getOriginTime(node);
        node.d = Math.max(0, nodeTime - parentTime);
      } else {
        node.d = node.alifeId === -1 ? 0 : 0;
      }
      for (const child of node.child) {
        stack.push(child);
      }
    }
  }

  sendStatusMessage({ message: "Computing tree layout" });

  // Compute num_tips (iterative post-order)
  const postOrder: JsTreeNode[] = [];
  const dfsStack: JsTreeNode[] = [root];
  while (dfsStack.length > 0) {
    const node = dfsStack.pop()!;
    postOrder.push(node);
    for (const child of node.child) {
      dfsStack.push(child);
    }
  }
  for (let i = postOrder.length - 1; i >= 0; i--) {
    const node = postOrder[i];
    if (node.child.length === 0) {
      node.num_tips = 1;
    } else {
      node.num_tips = 0;
      for (const child of node.child) {
        node.num_tips += child.num_tips!;
      }
    }
  }
  const total_tips = root.num_tips!;

  // Optionally ladderize
  if (ladderize) {
    const sortStack: JsTreeNode[] = [root];
    while (sortStack.length > 0) {
      const node = sortStack.pop()!;
      node.child.sort((a, b) => a.num_tips! - b.num_tips!);
      for (const child of node.child) {
        sortStack.push(child);
      }
    }
  }

  // Build jstree tree object and compute layout
  const nodeArray = kn_expand_node(root);
  const tree: any = {
    node: nodeArray,
    root: root,
    n_tips: total_tips,
    error: 0,
  };

  kn_calxy(tree, hasOriginTime);

  sendStatusMessage({ message: "Sorting on Y" });
  tree.node.sort((a: any, b: any) => a.y - b.y);

  sendStatusMessage({ message: "Finalising tree" });

  // Cleanup: assign node_ids and create final node format
  tree.node.forEach((node: any, i: number) => {
    node.node_id = i;
  });

  tree.node = tree.node.map((node: any) => {
    const cleaned: any = {
      name: node.name,
      parent_id: node.parent ? node.parent.node_id : node.node_id,
      x_dist: node.x,
      mutations: emptyList,
      y: node.y,
      num_tips: node.num_tips,
      is_tip: node.child.length === 0,
      node_id: node.node_id,
    };
    // Carry over metadata fields
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("meta_")) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });

  // Scale coordinates (same approach as processNewick cleanup)
  const scale_y = 2000;
  const all_xes = tree.node.map((node: any) => node.x_dist);
  all_xes.sort((a: number, b: number) => a - b);
  const ref_x_percentile = 0.99;
  const ref_x = all_xes[Math.floor(all_xes.length * ref_x_percentile)];
  const scale_x = ref_x > 0 ? 450 / ref_x : 1;

  tree.node.forEach((node: any) => {
    node.x_dist = node.x_dist * scale_x;
    node.y = node.y * scale_y;
  });

  const overallMaxX = reduceMaxOrMin(tree.node, (x: any) => x.x_dist, "max");
  const overallMinX = reduceMaxOrMin(tree.node, (x: any) => x.x_dist, "min");
  const overallMaxY = reduceMaxOrMin(tree.node, (x: any) => x.y, "max");
  const overallMinY = reduceMaxOrMin(tree.node, (x: any) => x.y, "min");
  const y_positions = tree.node.map((x: any) => x.y);

  const output: ProcessedTree = {
    nodes: tree.node,
    overallMaxX,
    overallMaxY,
    overallMinX,
    overallMinY,
    y_positions,
    mutations: [],
    node_to_mut: {},
    rootMutations: [],
    rootId: 0,
    overwrite_config: { num_tips: total_tips, from_newick: true },
  };

  return output;
}

export async function processAlife(
  data: AlifeFile,
  sendStatusMessage: (msg: StatusMessage) => void
): Promise<ProcessedTree> {
  const isTsv = data.filetype === "alife_tsv";
  sendStatusMessage({ message: `Parsing ALife ${isTsv ? "TSV" : "CSV"} file` });

  // Reuse processMetadataFile to parse the CSV/TSV.
  // Column 0 becomes the map key; all other columns get meta_ prefix.
  const metadataInput: MetadataFile = {
    status: data.status,
    filename: data.filename,
    data: data.data,
    filetype: isTsv ? "meta_tsv" : "meta_csv",
  };
  const [parsedMap, headers] = await processMetadataFile(
    metadataInput,
    sendStatusMessage
  );

  return buildAlifeTreeFromParsedData(parsedMap, headers, data.ladderize, sendStatusMessage);
}
