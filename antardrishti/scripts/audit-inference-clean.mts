/**
 * ANTARDRISHTI -- ONNX Inference Audit (Clean)
 * GO/NO-GO: proves actual ONNX inference for all 4 models.
 * Run: npx tsx scripts/audit-inference-clean.mts
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createCanvas } from "canvas";

let ort: any;
try { ort = await import("onnxruntime-node"); }
catch { console.error("[FATAL] onnxruntime-node not installed"); process.exit(1); }

const MODELS_DIR = path.join(process.cwd(), "apps/extension/assets/models");

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const manifest = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, "model-manifest.json"), "utf-8"));

// Load PP-OCR charset: 6623 chars from file + space = 6624; blank at index 0 = 6625 total classes
const PP_OCR_CHARSET: string[] = fs.readFileSync(path.join(MODELS_DIR, "ppocr_keys_v1.txt"), "utf-8")
  .split("\n").map((l: string) => l.replace(/\r$/, "")).filter((l: string) => l.length > 0);
PP_OCR_CHARSET.push(" ");
console.log(`PP-OCR charset: ${PP_OCR_CHARSET.length} chars (expect 6624)`);

function ctcDecode(logits: Float32Array, shape: number[], charset: string[]): { text: string; conf: number } {
  let T: number, C: number;
  if (shape.length === 3) [, T, C] = shape;
  else if (shape.length === 2) [T, C] = shape;
  else return { text: "", conf: 0 };
  let prev = -1, text = "", total = 0, n = 0;
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let maxV = -Infinity, maxI = 0;
    for (let c = 0; c < C; c++) if (logits[off+c] > maxV) { maxV = logits[off+c]; maxI = c; }
    if (maxI === 0 || maxI === prev) { prev = maxI; continue; }
    prev = maxI;
    const ci = maxI - 1;
    if (ci >= 0 && ci < charset.length) { text += charset[ci]; total += logits[off+maxI]; n++; }
  }
  return { text, conf: n > 0 ? Math.min(1, total / n) : 0 };
}

function toCHW(d: any, w: number, h: number, mean: number[], std: number[]): Float32Array {
  const t = new Float32Array(3 * h * w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y*w+x)*4, p = y*w+x;
      t[0*h*w+p] = (d.data[s+0]/255 - mean[0]) / std[0];
      t[1*h*w+p] = (d.data[s+1]/255 - mean[1]) / std[1];
      t[2*h*w+p] = (d.data[s+2]/255 - mean[2]) / std[2];
    }
  return t;
}

function makeScene(w: number, h: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as any;
  ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "white"; ctx.font = "bold 24px monospace";
  ctx.fillText("Account: 1234 5678 9012 3456", 60, 100);
  ctx.fillText("PAN: ABCDE1234F", 60, 150);
  ctx.fillStyle = "#238636"; ctx.fillRect(60, 500, 200, 50);
  ctx.fillStyle = "white"; ctx.fillText("Pay Now", 110, 532);
  return ctx.getImageData(0, 0, w, h);
}

function makeText(text: string, w = 320, h = 48) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as any;
  ctx.fillStyle = "black"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "white"; ctx.font = "bold 28px monospace"; ctx.fillText(text, 4, 36);
  return ctx.getImageData(0, 0, w, h);
}

function makeFace(w: number, h: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as any;
  ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#d4956a"; ctx.beginPath(); ctx.ellipse(w/2, h/2, w*0.22, h*0.38, 0, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "#2d1b00";
  ctx.beginPath(); ctx.ellipse(w*0.42, h*0.44, w*0.04, h*0.04, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(w*0.58, h*0.44, w*0.04, h*0.04, 0, 0, Math.PI*2); ctx.fill();
  return ctx.getImageData(0, 0, w, h);
}

const results: any[] = [];
let allPass = true;

// 1. PP-OCRv4 Text Detector
console.log("\n[1/4] PP-OCRv4 Text Detector");
{
  const mp = path.join(MODELS_DIR, "text-detector.onnx");
  const hash = sha256File(mp);
  const hashMatch = hash === manifest.models.find((m: any) => m.filename === "text-detector.onnx")?.sha256;
  console.log(`  hash: ${hash.slice(0,16)}...  match=${hashMatch}`);
  try {
    const sess = await ort.InferenceSession.create(mp, { executionProviders: ["cpu"] });
    const scene = makeScene(640, 640);
    const tensor = toCHW(scene, 640, 640, [0.485,0.456,0.406], [0.229,0.224,0.225]);
    const t0 = performance.now();
    const out = await sess.run({ x: new ort.Tensor("float32", tensor, [1,3,640,640]) });
    const lat = Math.round(performance.now() - t0);
    const outKey = Object.keys(out)[0];
    const prob = out[outKey].data as Float32Array;
    const regions = Array.from(prob).filter(v => v > 0.3).length;
    const shape = JSON.stringify([...out[outKey].dims]);
    console.log(`  PASS  latency=${lat}ms  output=${shape}  pixels>0.3: ${regions}`);
    results.push({ model: "PP-OCRv4 Text Detector", file: "text-detector.onnx", hash, hashMatch, lat, status: "PASS",
      input: "[1,3,640,640]", output: shape, detail: `${regions} pixels > 0.3` });
    await sess.release();
  } catch (e: any) {
    console.error("  FAIL:", e.message);
    results.push({ model: "PP-OCRv4 Text Detector", file: "text-detector.onnx", hash, hashMatch: false, lat: 0, status: "FAIL", detail: String(e) });
    allPass = false;
  }
}

// 2. PP-OCRv4 Text Recognizer (CTC)
console.log("\n[2/4] PP-OCRv4 Text Recognizer (CTC)");
{
  const mp = path.join(MODELS_DIR, "ocr-recognizer.onnx");
  const hash = sha256File(mp);
  const hashMatch = hash === manifest.models.find((m: any) => m.filename === "ocr-recognizer.onnx")?.sha256;
  console.log(`  hash: ${hash.slice(0,16)}...  match=${hashMatch}`);
  try {
    const sess = await ort.InferenceSession.create(mp, { executionProviders: ["cpu"] });
    console.log(`  outputs: ${JSON.stringify(sess.outputNames)}`);
    const tests = [
      { text: "9876543210", w: 320, h: 48 },
      { text: "Pay Now", w: 200, h: 48 },
      { text: "1234 5678 9012 3456", w: 320, h: 48 },
    ];
    let numClasses = 0;
    const decoded: any[] = [];
    for (const { text, w, h } of tests) {
      const img = makeText(text, w, h);
      const tensor = toCHW(img, w, h, [0.5,0.5,0.5], [0.5,0.5,0.5]);
      const t0 = performance.now();
      const out = await sess.run({ x: new ort.Tensor("float32", tensor, [1,3,h,w]) });
      const lat = Math.round(performance.now() - t0);
      const outKey = sess.outputNames[0];
      const logits = out[outKey].data as Float32Array;
      const shape = [...out[outKey].dims] as number[];
      numClasses = shape[2];
      const { text: dec, conf } = ctcDecode(logits, shape, PP_OCR_CHARSET);
      console.log(`  "${text}" => "${dec}" conf=${conf.toFixed(3)} lat=${lat}ms shape=${JSON.stringify(shape)}`);
      decoded.push({ input: text, output: dec, conf, lat });
    }
    const charsetMatch = numClasses === PP_OCR_CHARSET.length + 1;
    console.log(`  num_classes=${numClasses}  charset+blank=${PP_OCR_CHARSET.length + 1}  match=${charsetMatch}`);
    results.push({ model: "PP-OCRv4 Recognizer (CTC)", file: "ocr-recognizer.onnx", hash, hashMatch, lat: decoded[0].lat,
      status: "PASS", numClasses, charsetMatch,
      input: "[1,3,48,W]", output: `[1,T,${numClasses}]`,
      detail: decoded.map(d => '"' + d.input + '"=>"' + d.output + '"(' + d.conf.toFixed(2) + ')').join(" | ") });
    await sess.release();
  } catch (e: any) {
    console.error("  FAIL:", e.message);
    results.push({ model: "PP-OCRv4 Recognizer (CTC)", file: "ocr-recognizer.onnx", hash, hashMatch: false, lat: 0, status: "FAIL", detail: String(e) });
    allPass = false;
  }
}

// 3. BlazeFace Short Range
console.log("\n[3/4] BlazeFace Short Range");
{
  const mp = path.join(MODELS_DIR, "face-detector.onnx");
  const hash = sha256File(mp);
  const hashMatch = hash === manifest.models.find((m: any) => m.filename === "face-detector.onnx")?.sha256;
  console.log(`  hash: ${hash.slice(0,16)}...  match=${hashMatch}`);
  try {
    const sess = await ort.InferenceSession.create(mp, { executionProviders: ["cpu"] });
    console.log(`  inputs:  ${JSON.stringify(sess.inputNames)}`);
    console.log(`  outputs: ${JSON.stringify(sess.outputNames)}`);
    const INPUT_SIZE = 128;
    const face = makeFace(INPUT_SIZE, INPUT_SIZE);
    const tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    for (let y = 0; y < INPUT_SIZE; y++)
      for (let x = 0; x < INPUT_SIZE; x++) {
        const s = (y*INPUT_SIZE+x)*4, p = y*INPUT_SIZE+x;
        tensor[0*INPUT_SIZE*INPUT_SIZE+p] = (face.data[s+0]/127.5) - 1;
        tensor[1*INPUT_SIZE*INPUT_SIZE+p] = (face.data[s+1]/127.5) - 1;
        tensor[2*INPUT_SIZE*INPUT_SIZE+p] = (face.data[s+2]/127.5) - 1;
      }
    const t0 = performance.now();
    const out = await sess.run({
      image: new ort.Tensor("float32", tensor, [1,3,INPUT_SIZE,INPUT_SIZE]),
      conf_threshold: new ort.Tensor("float32", new Float32Array([0.3]), [1]),
      max_detections: new ort.Tensor("int64", new BigInt64Array([BigInt(10)]), [1]),
      iou_threshold: new ort.Tensor("float32", new Float32Array([0.3]), [1]),
    });
    const lat = Math.round(performance.now() - t0);
    const boxes = out["selectedBoxes"] as any;
    const dims = [...boxes.dims] as number[];
    const N = dims.length >= 3 ? dims[1] : 1;
    const d0 = Array.from(boxes.data as Float32Array).slice(0,4).map((v: any) => Number(v).toFixed(3)).join(",");
    console.log(`  PASS  latency=${lat}ms  selectedBoxes=${JSON.stringify(dims)}  N=${N}  box[0:4]=[${d0}]`);
    results.push({ model: "BlazeFace Short Range", file: "face-detector.onnx", hash, hashMatch, lat, status: "PASS",
      input: "[1,3,128,128] NCHW", output: "selectedBoxes " + JSON.stringify(dims),
      detail: `${N} detection(s), box[0:4]=[${d0}]` });
    await sess.release();
  } catch (e: any) {
    console.error("  FAIL:", e.message);
    results.push({ model: "BlazeFace Short Range", file: "face-detector.onnx", hash, hashMatch: false, lat: 0, status: "FAIL", detail: String(e) });
    allPass = false;
  }
}

// 4. OmniParser icon_detect (YOLO)
console.log("\n[4/4] OmniParser icon_detect (YOLO)");
{
  const mp = path.join(MODELS_DIR, "ui-region-detector.onnx");
  const hash = sha256File(mp);
  const hashMatch = hash === manifest.models.find((m: any) => m.filename === "ui-region-detector.onnx")?.sha256;
  console.log(`  hash: ${hash.slice(0,16)}...  match=${hashMatch}`);
  try {
    const sess = await ort.InferenceSession.create(mp, { executionProviders: ["cpu"] });
    const INPUT_SIZE = 640;
    const scene = makeScene(INPUT_SIZE, INPUT_SIZE);
    const tensor = toCHW(scene, INPUT_SIZE, INPUT_SIZE, [0,0,0], [1,1,1]);
    const t0 = performance.now();
    const out = await sess.run({ images: new ort.Tensor("float32", tensor, [1,3,INPUT_SIZE,INPUT_SIZE]) });
    const lat = Math.round(performance.now() - t0);
    const data = out["output0"].data as Float32Array;
    const shape = [...out["output0"].dims] as number[];
    const [, C, A] = shape;
    let det = 0, maxConf = 0;
    for (let a = 0; a < A; a++) {
      let mx = 0;
      for (let c = 4; c < C; c++) { const s = data[c*A+a]; if (s > mx) mx = s; }
      if (mx > 0.25) { det++; if (mx > maxConf) maxConf = mx; }
    }
    console.log(`  PASS  latency=${lat}ms  output=${JSON.stringify(shape)}  detections>0.25: ${det}  maxConf=${maxConf.toFixed(3)}`);
    results.push({ model: "OmniParser icon_detect (YOLO)", file: "ui-region-detector.onnx", hash, hashMatch, lat, status: "PASS",
      input: "[1,3,640,640]", output: JSON.stringify(shape),
      detail: `${det} detections > 0.25, maxConf=${maxConf.toFixed(3)}` });
    await sess.release();
  } catch (e: any) {
    console.error("  FAIL:", e.message);
    results.push({ model: "OmniParser icon_detect", file: "ui-region-detector.onnx", hash, hashMatch: false, lat: 0, status: "FAIL", detail: String(e) });
    allPass = false;
  }
}

// Summary
console.log("\n============================================================");
console.log("  INFERENCE EVIDENCE SUMMARY");
console.log("============================================================\n");
for (const r of results) {
  console.log(`${r.status}  ${r.model}`);
  console.log(`   file:       ${r.file}`);
  console.log(`   hash:       ${r.hash?.slice(0,32)}...  match=${r.hashMatch}`);
  console.log(`   latency:    ${r.lat}ms`);
  console.log(`   input:      ${r.input}`);
  console.log(`   output:     ${r.output}`);
  console.log(`   detail:     ${r.detail}`);
  if (r.numClasses) console.log(`   numClasses: ${r.numClasses}  charsetMatch: ${r.charsetMatch}`);
  console.log();
}

const ocrResult = results.find(r => r.model.includes("Recognizer"));
const charsetOk = ocrResult?.charsetMatch === true;

console.log("============================================================");
console.log(`  All 4 models PASS: ${allPass}`);
console.log(`  All hashes match:  ${results.every(r => r.hashMatch)}`);
console.log(`  OCR charset OK:    ${charsetOk} (model=${ocrResult?.numClasses} classes, need=${PP_OCR_CHARSET.length + 1})`);

const report = { timestamp: new Date().toISOString(), charsetSize: PP_OCR_CHARSET.length, charsetOk, results, verdict: allPass && charsetOk ? "GO" : "NO-GO" };
const rp = path.join(process.cwd(), "audit-onnx-evidence.json");
fs.writeFileSync(rp, JSON.stringify(report, null, 2));
console.log(`\n  Report: ${rp}`);

if (allPass && charsetOk) {
  console.log("\n  [GO] INFERENCE AUDIT: ALL MODELS PASS\n");
} else {
  console.log("\n  [NO-GO] INFERENCE AUDIT: see failures above\n");
  process.exit(1);
}
