import { readFileSync, writeFileSync } from "fs";
import { basename, resolve } from "path";
import { exportBoardFromSource } from "kicad-board-export";

function parseArgs(): { pcb: string; out: string } {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    })
  );
  const pcb = args["pcb"] as string | undefined;
  const out = args["out"] as string | undefined;
  if (!pcb || !out) {
    console.error("Usage: npm run kicad:export-board -- --pcb=path/to/board.kicad_pcb --out=board-viewer.json");
    process.exit(1);
  }
  return { pcb: resolve(pcb), out: resolve(out) };
}

const { pcb, out } = parseArgs();
const source = readFileSync(pcb, "utf-8");
const artifact = exportBoardFromSource(source, {
  filename: basename(pcb),
  exporter: "scripts/kicad/export-board-viewer.ts",
});
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`Exported ${artifact.nets.length} nets, ${artifact.tracks.length} tracks, ${artifact.vias.length} vias, ${artifact.pads.length} pads.`);
console.log(out);
