/**
 * ANTARDRISHTI — Model Runner Package Barrel Export
 *
 * Production path exports:
 *   onnx-adapters   — real ONNX inference sessions
 *   model-manifests — pinned SHA-256 model manifests + loader
 *
 * DEV_FALLBACK exports (clearly labeled):
 *   browser-adapters — pixel heuristics for offline dev/testing
 */

export * from './types';
export * from './runtime';
export * from './onnx-session';
export * from './metrics';
export * from './pipeline';

// PRODUCTION: ONNX adapters (PP-OCRv4, BlazeFace, OmniParser)
export * from './onnx-adapters';

// PRODUCTION: Pinned model manifests + batch loader
export * from './model-manifests';

// DEV_FALLBACK: pixel heuristics (NOT production perception)
export * from './browser-adapters';
