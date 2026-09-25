import { downloadZip, predictLength } from "../../vendor/client-zip-2.5.1/index.js";
import { blobSource } from "./source.mjs";

function stableEntries(files, lastModified) {
  return [...files].map((file) => ({
    name: file.name,
    lastModified: lastModified instanceof Date ? lastModified : new Date(lastModified || 0),
    input: file,
    size: file.size,
  }));
}

export async function packLoose(files, { lastModified = new Date(0), name = "stems.zip" } = {}) {
  const entries = stableEntries(files, lastModified);
  const predicted = Number(predictLength(entries.map((entry) => ({ ...entry }))));
  const packed = await downloadZip(stableEntries(files, lastModified)).blob();
  const file = new File([packed], name, { type: "application/zip", lastModified: lastModified instanceof Date ? lastModified.getTime() : 0 });
  return {
    file,
    source: blobSource(file),
    predictedLength: predicted,
    actualLength: file.size,
    deterministic: true,
  };
}
