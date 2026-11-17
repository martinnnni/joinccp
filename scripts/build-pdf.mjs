import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  copyFileSync(resolve("node_modules/pdfjs-dist/build", name), resolve("public", name.replace(/\.mjs$/, ".js")));
}
