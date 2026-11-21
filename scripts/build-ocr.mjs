import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const output = "public/ocr";
mkdirSync(output, { recursive: true });
const distribution = "node_modules/tesseract.js/dist";
for (const file of ["tesseract.esm.min.js", "worker.min.js", "tesseract.min.js.LICENSE.txt", "worker.min.js.LICENSE.txt"]) {
  copyFileSync(join(distribution, file), join(output, file));
}
const core = "node_modules/tesseract.js-core";
for (const file of readdirSync(core).filter(name => name.endsWith("-lstm.wasm.js") || name === "LICENSE")) {
  copyFileSync(join(core, file), join(output, file));
}
for (const lang of ["chi_sim", "eng"]) {
  copyFileSync("node_modules/@tesseract.js-data/" + lang + "/4.0.0_best_int/" + lang + ".traineddata.gz", join(output, lang + ".traineddata.gz"));
}
