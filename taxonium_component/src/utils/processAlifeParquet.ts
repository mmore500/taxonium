import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { buildAlifeTreeFromParsedData } from "./processAlife";
import type { StatusMessage } from "../types/backend";
import type { AlifeParquetFile, ProcessedTree } from "../types/newick";

export async function processAlifeParquet(
  data: AlifeParquetFile,
  sendStatusMessage: (msg: StatusMessage) => void
): Promise<ProcessedTree> {
  sendStatusMessage({ message: "Parsing ALife Parquet file" });

  // Get the ArrayBuffer from the uploaded file data
  let arrayBuffer: ArrayBuffer;
  if (data.data instanceof ArrayBuffer) {
    arrayBuffer = data.data;
  } else if (typeof data.data === "string") {
    const encoder = new TextEncoder();
    arrayBuffer = encoder.encode(data.data).buffer as ArrayBuffer;
  } else {
    throw new Error("Parquet file data must be an ArrayBuffer");
  }

  // Read parquet file into array of row objects
  const rows = await parquetReadObjects({
    file: arrayBuffer,
    compressors,
  });

  if (rows.length === 0) {
    sendStatusMessage({ error: "ALife Parquet file contains no data rows" });
    throw new Error("ALife Parquet file contains no data rows");
  }

  // Extract column headers from the first row's keys
  const headers = Object.keys(rows[0]);

  // Convert to the same [Map, headers] format that processMetadataFile produces:
  // - Map key = first column's value (as string)
  // - Map value = { meta_col2: val, meta_col3: val, ... } (other columns with meta_ prefix)
  const col0 = headers[0];
  const parsedMap = new Map<string, Record<string, string>>();

  for (const row of rows) {
    const keyValue = String(row[col0] ?? "");
    const metaObj: Record<string, string> = {};
    for (let i = 1; i < headers.length; i++) {
      metaObj["meta_" + headers[i]] = String(row[headers[i]] ?? "");
    }
    parsedMap.set(keyValue, metaObj);
  }

  return buildAlifeTreeFromParsedData(
    parsedMap,
    headers,
    data.ladderize,
    sendStatusMessage
  );
}
