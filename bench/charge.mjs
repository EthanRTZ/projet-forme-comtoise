const url = process.argv[2];
if (!url) throw new Error("Usage: node bench/charge.mjs URL [output.csv]");
const output = process.argv[3] || "resultats/mesures.csv";
const CLIENTS = 20, REQUETES = 20, mesures = [];
async function client(numero) {
  for (let rang = 1; rang <= REQUETES; rang++) {
    const debut = performance.now();
    let statut = 0;
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      statut = response.status;
    } catch {}
    mesures.push({ client: numero, rang, ms: performance.now() - debut, statut });
  }
}
for (let i = 0; i < 20; i++) await fetch(url).catch(() => {});
const t0 = performance.now();
await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i + 1)));
const duree = (performance.now() - t0) / 1000;
const ok = mesures.filter(m => m.statut === 200).map(m => m.ms).sort((a, b) => a - b);
const moyenne = ok.reduce((a, b) => a + b, 0) / (ok.length || 1);
const ecartType = Math.sqrt(ok.reduce((s, x) => s + (x - moyenne) ** 2, 0) / Math.max(1, ok.length - 1));
const p95 = ok[Math.max(0, Math.ceil(.95 * ok.length) - 1)] || 0;
const stats = { moyenne, ecartType, p95, echecs: mesures.length - ok.length, debit: mesures.length / duree, duree, reussites: ok.length };
console.log(JSON.stringify(stats, null, 2));
const fs = await import("node:fs/promises");
await fs.mkdir(new URL(".", `file://${process.cwd()}/${output}`), { recursive: true }).catch(() => {});
await fs.writeFile(output, "client,rang,ms,statut\n" + mesures.map(m => `${m.client},${m.rang},${m.ms.toFixed(3)},${m.statut}`).join("\n"));
