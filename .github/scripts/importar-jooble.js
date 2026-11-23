const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const crypto = require("crypto");

const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
const apiKey = (process.env.JOOBLE_API_KEY || "").trim();

if (!serviceAccountRaw) throw new Error("Segredo FIREBASE_SERVICE_ACCOUNT não configurado.");
if (!apiKey) throw new Error("Segredo JOOBLE_API_KEY não configurado.");

initializeApp({
  credential: cert(JSON.parse(serviceAccountRaw))
});

const db = getFirestore();

const TERMOS_BUSCA = [
  "motorista",
  "vendedor",
  "pedreiro",
  "auxiliar administrativo",
  "atendente",
  "eletricista"
];

async function run() {
  const endpoint = `https://br.jooble.org/api/${apiKey}`;
  const agora = Timestamp.now();
  const candidatas = new Map();

  for (const palavra of TERMOS_BUSCA) {
    try {
      const resposta = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: palavra, location: "Uberaba" })
      });

      if (!resposta.ok) {
        console.error(`Erro HTTP ${resposta.status} ao buscar "${palavra}"`);
        continue;
      }

      const dados = await resposta.json();
      const lista = Array.isArray(dados.jobs) ? dados.jobs : [];
      console.log(`Termo "${palavra}": ${lista.length} vagas encontradas.`);

      for (const vaga of lista) {
        if (!vaga.link || !/^https?:\/\//i.test(vaga.link)) continue;

        const docId = vaga.id
          ? `jooble_${String(vaga.id).replace(/[^a-zA-Z0-9_-]/g, "")}`
          : `jooble_${crypto.createHash("sha256").update(vaga.link).digest("hex").slice(0, 24)}`;

        if (!candidatas.has(docId)) {
          candidatas.set(docId, {
            titulo: String(vaga.title || "Vaga sem título").trim(),
            empresa: String(vaga.company || "Empresa não informada").trim() || "Empresa não informada",
            cidade: String(vaga.location || "Uberaba - MG").trim(),
            dataPublicacao: vaga.updated ? String(vaga.updated) : new Date().toISOString(),
            linkOriginal: String(vaga.link).trim(),
            fonte: "Jooble",
            importadaEm: agora
          });
        }
      }
    } catch (err) {
      console.error(`Falha ao buscar "${palavra}":`, err);
    }
  }

  let novasSalvas = 0;
  const entradas = Array.from(candidatas.entries());

  for (let i = 0; i < entradas.length; i += 100) {
    const fatia = entradas.slice(i, i + 100);
    const refs = fatia.map(([id]) => db.collection("vagas_externas").doc(id));
    const existentes = await db.getAll(...refs);

    const batch = db.batch();
    let temGravacao = false;

    existentes.forEach((snap, idx) => {
      if (!snap.exists) {
        const [id, dadosVaga] = fatia[idx];
        batch.set(db.collection("vagas_externas").doc(id), dadosVaga);
        temGravacao = true;
        novasSalvas++;
      }
    });

    if (temGravacao) await batch.commit();
  }

  const trintaDiasAtras = Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const antigasSnap = await db
    .collection("vagas_externas")
    .where("importadaEm", "<", trintaDiasAtras)
    .limit(400)
    .get();

  let apagadas = 0;
  if (!antigasSnap.empty) {
    const delBatch = db.batch();
    antigasSnap.forEach((docSnap) => {
      delBatch.delete(docSnap.ref);
      apagadas++;
    });
    await delBatch.commit();
  }

  console.log(`Concluído: ${novasSalvas} novas vagas salvas, ${apagadas} antigas (>30 dias) apagadas.`);
}

run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
