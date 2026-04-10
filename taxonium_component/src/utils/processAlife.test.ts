import { describe, it, expect, vi } from "vitest";
import { processAlife } from "./processAlife";
import type { AlifeFile } from "../types/newick";

function makeAlifeFile(csvText: string, opts?: Partial<AlifeFile>): AlifeFile {
  return {
    status: "loaded",
    filename: "test.csv",
    data: csvText,
    filetype: "alife",
    ladderize: false,
    ...opts,
  };
}

const noopStatus = vi.fn();

describe("processAlife", () => {
  // --- Column variant tests ---

  describe("ancestor_id only", () => {
    it("builds correct tree topology", async () => {
      const csv = [
        "id,ancestor_id,origin_time",
        "0,,0",
        "1,0,1",
        "2,0,2",
        "3,1,3",
        "4,1,4",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      expect(result.nodes.length).toBe(5);
      expect(result.overwrite_config.num_tips).toBe(3); // nodes 2, 3, 4
      // Root node should have parent_id === its own node_id
      const root = result.nodes.find((n: any) => n.name === "0");
      expect(root).toBeDefined();
      expect(root!.parent_id).toBe(root!.node_id);
      // Check tips
      const tips = result.nodes.filter((n: any) => n.is_tip);
      expect(tips.length).toBe(3);
    });
  });

  describe("ancestor_list only", () => {
    it("builds correct tree topology", async () => {
      const csv = [
        "id,ancestor_list,origin_time",
        "0,[none],0",
        "1,[0],1",
        "2,[0],2",
        "3,[1],3",
        "4,[1],4",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      expect(result.nodes.length).toBe(5);
      expect(result.overwrite_config.num_tips).toBe(3);
      const root = result.nodes.find((n: any) => n.name === "0");
      expect(root).toBeDefined();
      expect(root!.parent_id).toBe(root!.node_id);
    });

    it("handles various root indicators", async () => {
      // Test [NONE], [], and empty ancestor_list
      const csv = [
        "id,ancestor_list",
        "10,[NONE]",
        "11,[10]",
        "20,[]",
        "21,[20]",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      // Two roots -> synthetic root + 4 data nodes = 5
      expect(result.nodes.length).toBe(5);
      const syntheticRoot = result.nodes.find(
        (n: any) => n.name === "synthetic_root"
      );
      expect(syntheticRoot).toBeDefined();
    });
  });

  describe("ancestor_list with multiple parents", () => {
    it("uses only the first ancestor (tree-only mode)", async () => {
      const csv = [
        "id,ancestor_list",
        "0,[none]",
        "1,[0]",
        "2,[0]",
        "3,[1,2]",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      // Node 3 should be a child of node 1 (first ancestor), not node 2
      expect(result.nodes.length).toBe(4);
      const node3 = result.nodes.find((n: any) => n.name === "3");
      expect(node3).toBeDefined();
      const node1 = result.nodes.find((n: any) => n.name === "1");
      expect(node3!.parent_id).toBe(node1!.node_id);
    });
  });

  describe("both ancestor_list and ancestor_id", () => {
    it("prefers ancestor_id when both are present", async () => {
      const csv = [
        "id,ancestor_id,ancestor_list",
        "0,,[none]",
        "1,0,[0]",
        "2,0,[0]",
        "3,2,[1]",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      // ancestor_id says node 3's parent is 2, ancestor_list says 1
      // ancestor_id should take precedence
      const node3 = result.nodes.find((n: any) => n.name === "3");
      const node2 = result.nodes.find((n: any) => n.name === "2");
      expect(node3!.parent_id).toBe(node2!.node_id);
    });
  });

  // --- Functional tests ---

  describe("origin_time as branch distance", () => {
    it("uses time differences for x_dist", async () => {
      const csv = [
        "id,ancestor_list,origin_time",
        "0,[none],0",
        "1,[0],10",
        "2,[0],20",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      // Nodes should have different x_dist values reflecting their origin_time
      const node0 = result.nodes.find((n: any) => n.name === "0");
      const node1 = result.nodes.find((n: any) => n.name === "1");
      const node2 = result.nodes.find((n: any) => n.name === "2");

      // Node 2 is further in time, so should have larger x_dist
      expect(node2!.x_dist).toBeGreaterThan(node0!.x_dist);
      expect(node1!.x_dist).toBeGreaterThan(node0!.x_dist);
    });
  });

  describe("metadata columns", () => {
    it("attaches extra columns as meta_ properties", async () => {
      const csv = [
        "id,ancestor_id,color,shape",
        "0,,red,circle",
        "1,0,blue,square",
        "2,0,green,triangle",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      const node0 = result.nodes.find((n: any) => n.name === "0");
      expect(node0!.meta_color).toBe("red");
      expect(node0!.meta_shape).toBe("circle");

      const node1 = result.nodes.find((n: any) => n.name === "1");
      expect(node1!.meta_color).toBe("blue");
      expect(node1!.meta_shape).toBe("square");
    });
  });

  describe("multiple roots", () => {
    it("creates a synthetic root to connect them", async () => {
      const csv = [
        "id,ancestor_id",
        "0,",
        "1,0",
        "2,",
        "3,2",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      // 4 data nodes + 1 synthetic root = 5
      expect(result.nodes.length).toBe(5);
      const syntheticRoot = result.nodes.find(
        (n: any) => n.name === "synthetic_root"
      );
      expect(syntheticRoot).toBeDefined();
      expect(syntheticRoot!.parent_id).toBe(syntheticRoot!.node_id);
    });
  });

  // --- Edge case tests ---

  describe("empty tree", () => {
    it("throws error for header-only CSV", async () => {
      const csv = "id,ancestor_id,origin_time\n";

      await expect(
        processAlife(makeAlifeFile(csv), noopStatus)
      ).rejects.toThrow("ALife CSV contains no valid data rows");
    });
  });

  describe("single-node tree", () => {
    it("produces a valid single-node tree", async () => {
      const csv = ["id,ancestor_id", "0,"].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].name).toBe("0");
      expect(result.nodes[0].is_tip).toBe(true);
      expect(result.nodes[0].parent_id).toBe(result.nodes[0].node_id);
    });
  });

  describe("empty/malformed lines", () => {
    it("gracefully skips trailing newlines and blank lines", async () => {
      const csv = [
        "id,ancestor_id",
        "0,",
        "",
        "1,0",
        "",
        "",
      ].join("\n");

      const result = await processAlife(makeAlifeFile(csv), noopStatus);

      expect(result.nodes.length).toBe(2);
    });
  });

  describe("missing ancestor columns", () => {
    it("throws error when neither ancestor_list nor ancestor_id exists", async () => {
      const csv = ["id,origin_time", "0,0", "1,1"].join("\n");

      await expect(
        processAlife(makeAlifeFile(csv), noopStatus)
      ).rejects.toThrow(
        "ALife CSV must have an 'ancestor_list' or 'ancestor_id' column"
      );
    });
  });

  describe("ladderize option", () => {
    it("produces a valid tree when ladderize is true", async () => {
      const csv = [
        "id,ancestor_id",
        "0,",
        "1,0",
        "2,0",
        "3,1",
        "4,1",
        "5,1",
      ].join("\n");

      const result = await processAlife(
        makeAlifeFile(csv, { ladderize: true }),
        noopStatus
      );

      expect(result.nodes.length).toBe(6);
      expect(result.overwrite_config.num_tips).toBe(4); // nodes 2, 3, 4, 5
    });
  });
});
