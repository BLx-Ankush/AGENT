/**
 * ANTARDRISHTI — Chrome MV3 Service Worker
 *
 * Coordinates the extension. Owns session state, message routing,
 * capture pipeline, and (later) planner transport.
 *
 * Phase 1: NO planner network calls. Zero outbound requests.
 */

import { Coordinator } from './coordinator';

const coordinator = new Coordinator();

// ── Extension lifecycle ──────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[ANTARDRISHTI] Installed:', details.reason);
  coordinator.initialize();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[ANTARDRISHTI] Started');
  coordinator.initialize();
});

// ── Message routing ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  coordinator.handleMessage(message, sender, sendResponse);
  return true; // keep sendResponse channel open for async
});

// ── Tab lifecycle ────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    coordinator.handleTabUpdated(tabId, changeInfo, tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  coordinator.handleTabRemoved(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  coordinator.handleTabActivated(activeInfo);
});

console.log('[ANTARDRISHTI] Service worker loaded — no network configured');
