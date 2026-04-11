// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { buildAlifeTreeFromParsedData } from "./processAlife";
import { processAlifeParquet } from "./processAlifeParquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import type { AlifeParquetFile } from "../types/newick";

const noopStatus = vi.fn();

const encoder = new TextEncoder();

// Helper to create a parquet ArrayBuffer from column arrays
function makeParquetBuffer(
  columns: { name: string; data: (string | number | null)[] }[]
): ArrayBuffer {
  const columnData = columns.map((col) => ({
    name: col.name,
    data: col.data.map((v) =>
      encoder.encode(v === null ? "" : String(v))
    ),
  }));
  return parquetWriteBuffer({ columnData, codec: "UNCOMPRESSED" });
}

function makeParquetFile(
  buffer: ArrayBuffer,
  opts?: Partial<AlifeParquetFile>
): AlifeParquetFile {
  return {
    status: "loaded",
    filename: "test.parquet",
    data: buffer,
    filetype: "alife_parquet",
    ladderize: false,
    ...opts,
  };
}

// ---- Tests for buildAlifeTreeFromParsedData (shared logic) ----

describe("buildAlifeTreeFromParsedData", () => {
  it("builds correct tree from parsedMap with ancestor_id", async () => {
    const parsedMap = new Map<string, Record<string, string>>();
    parsedMap.set("0", { meta_ancestor_id: "", meta_origin_time: "0" });
    parsedMap.set("1", { meta_ancestor_id: "0", meta_origin_time: "1" });
    parsedMap.set("2", { meta_ancestor_id: "0", meta_origin_time: "2" });
    parsedMap.set("3", { meta_ancestor_id: "1", meta_origin_time: "3" });
    parsedMap.set("4", { meta_ancestor_id: "1", meta_origin_time: "4" });
    const headers = ["id", "ancestor_id", "origin_time"];

    const result = await buildAlifeTreeFromParsedData(
      parsedMap,
      headers,
      false,
      noopStatus
    );

    expect(result.nodes.length).toBe(5);
    expect(result.overwrite_config.num_tips).toBe(3); // nodes 2, 3, 4
    const root = result.nodes.find((n: any) => n.name === "0");
    expect(root).toBeDefined();
    expect(root!.parent_id).toBe(root!.node_id);
    const tips = result.nodes.filter((n: any) => n.is_tip);
    expect(tips.length).toBe(3);
  });

  it("uses origin_time for branch distances", async () => {
    const parsedMap = new Map<string, Record<string, string>>();
    parsedMap.set("0", { meta_ancestor_id: "", meta_origin_time: "0" });
    parsedMap.set("1", { meta_ancestor_id: "0", meta_origin_time: "10" });
    parsedMap.set("2", { meta_ancestor_id: "0", meta_origin_time: "20" });
    const headers = ["id", "ancestor_id", "origin_time"];

    const result = await buildAlifeTreeFromParsedData(
      parsedMap,
      headers,
      false,
      noopStatus
    );

    const node0 = result.nodes.find((n: any) => n.name === "0");
    const node2 = result.nodes.find((n: any) => n.name === "2");
    expect(node2!.x_dist).toBeGreaterThan(node0!.x_dist);
  });

  it("carries metadata columns through", async () => {
    const parsedMap = new Map<string, Record<string, string>>();
    parsedMap.set("0", {
      meta_ancestor_id: "",
      meta_color: "red",
      meta_shape: "circle",
    });
    parsedMap.set("1", {
      meta_ancestor_id: "0",
      meta_color: "blue",
      meta_shape: "square",
    });
    const headers = ["id", "ancestor_id", "color", "shape"];

    const result = await buildAlifeTreeFromParsedData(
      parsedMap,
      headers,
      false,
      noopStatus
    );

    const node0 = result.nodes.find((n: any) => n.name === "0");
    expect((node0 as any).meta_color).toBe("red");
    expect((node0 as any).meta_shape).toBe("circle");
  });

  it("creates synthetic root for multiple roots", async () => {
    const parsedMap = new Map<string, Record<string, string>>();
    parsedMap.set("0", { meta_ancestor_id: "" });
    parsedMap.set("1", { meta_ancestor_id: "0" });
    parsedMap.set("2", { meta_ancestor_id: "" });
    parsedMap.set("3", { meta_ancestor_id: "2" });
    const headers = ["id", "ancestor_id"];

    const result = await buildAlifeTreeFromParsedData(
      parsedMap,
      headers,
      false,
      noopStatus
    );

    expect(result.nodes.length).toBe(5);
    const syntheticRoot = result.nodes.find(
      (n: any) => n.name === "synthetic_root"
    );
    expect(syntheticRoot).toBeDefined();
  });

  it("treats self-referencing ancestor_id as root", async () => {
    const parsedMap = new Map<string, Record<string, string>>();
    parsedMap.set("0", { meta_ancestor_id: "0" });
    parsedMap.set("1", { meta_ancestor_id: "0" });
    parsedMap.set("2", { meta_ancestor_id: "0" });
    parsedMap.set("3", { meta_ancestor_id: "1" });
    const headers = ["id", "ancestor_id"];

    const result = await buildAlifeTreeFromParsedData(
      parsedMap,
      headers,
      false,
      noopStatus
    );

    expect(result.nodes.length).toBe(4);
    const root = result.nodes.find((n: any) => n.name === "0");
    expect(root).toBeDefined();
    expect(root!.parent_id).toBe(root!.node_id);
    expect(result.overwrite_config.num_tips).toBe(2); // nodes 2, 3
  });

  it("ladderizes when requested", async () => {
    const parsedMap = new Map<string, Record<string, string>>();
    parsedMap.set("0", { meta_ancestor_id: "" });
    parsedMap.set("1", { meta_ancestor_id: "0" });
    parsedMap.set("2", { meta_ancestor_id: "0" });
    parsedMap.set("3", { meta_ancestor_id: "1" });
    parsedMap.set("4", { meta_ancestor_id: "1" });
    parsedMap.set("5", { meta_ancestor_id: "1" });
    const headers = ["id", "ancestor_id"];

    const result = await buildAlifeTreeFromParsedData(
      parsedMap,
      headers,
      true,
      noopStatus
    );

    expect(result.nodes.length).toBe(6);
    expect(result.overwrite_config.num_tips).toBe(4);
  });
});

// ---- Tests for processAlifeParquet (end-to-end) ----

describe("processAlifeParquet", () => {
  it("builds correct tree from parquet with ancestor_id", async () => {
    const buffer = makeParquetBuffer([
      { name: "id", data: [0, 1, 2, 3, 4] },
      { name: "ancestor_id", data: ["", "0", "0", "1", "1"] },
      { name: "origin_time", data: [0, 1, 2, 3, 4] },
    ]);

    const result = await processAlifeParquet(
      makeParquetFile(buffer),
      noopStatus
    );

    expect(result.nodes.length).toBe(5);
    expect(result.overwrite_config.num_tips).toBe(3);
    const root = result.nodes.find((n: any) => n.name === "0");
    expect(root).toBeDefined();
    expect(root!.parent_id).toBe(root!.node_id);
  });

  it("attaches metadata columns from parquet", async () => {
    const buffer = makeParquetBuffer([
      { name: "id", data: [0, 1, 2] },
      { name: "ancestor_id", data: ["", "0", "0"] },
      { name: "color", data: ["red", "blue", "green"] },
      { name: "shape", data: ["circle", "square", "triangle"] },
    ]);

    const result = await processAlifeParquet(
      makeParquetFile(buffer),
      noopStatus
    );

    const node0 = result.nodes.find((n: any) => n.name === "0");
    expect((node0 as any).meta_color).toBe("red");
    expect((node0 as any).meta_shape).toBe("circle");

    const node1 = result.nodes.find((n: any) => n.name === "1");
    expect((node1 as any).meta_color).toBe("blue");
  });

  it("uses origin_time for distances in parquet", async () => {
    const buffer = makeParquetBuffer([
      { name: "id", data: [0, 1, 2] },
      { name: "ancestor_id", data: ["", "0", "0"] },
      { name: "origin_time", data: [0, 10, 20] },
    ]);

    const result = await processAlifeParquet(
      makeParquetFile(buffer),
      noopStatus
    );

    const node0 = result.nodes.find((n: any) => n.name === "0");
    const node2 = result.nodes.find((n: any) => n.name === "2");
    expect(node2!.x_dist).toBeGreaterThan(node0!.x_dist);
  });
});
