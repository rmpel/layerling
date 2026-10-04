"use strict";

// The web app keeps its preferences and its list of designs in localStorage.
// The desktop app keeps them in two readable files instead and only lends
// them to localStorage while it runs. This is the translation between the two.

/** The list of designs; it gets a file of its own. */
const PROJECTS_KEY = "layerling.projects";
/** Scratch values that mean nothing after the app has closed. */
const EPHEMERAL_KEYS = new Set(["layerling.clipboard"]);

/** Whether a localStorage key belongs in a file at all. */
function persistable(key) {
  return typeof key === "string" && key.startsWith("layerling.") && !EPHEMERAL_KEYS.has(key);
}

/**
 * A stored string as the value written to the file. JSON is unpacked so the
 * file stays readable - but only when packing it again gives back exactly the
 * same string, and never for a JSON string, which would lose its quotes.
 */
function decodeValue(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "string" && JSON.stringify(parsed) === raw) return parsed;
  } catch {
    // Plain text such as "dark" is no JSON, and stays as it is.
  }
  return raw;
}

/** The way back: a value from the file as the string localStorage holds. */
function encodeValue(stored) {
  return typeof stored === "string" ? stored : JSON.stringify(stored);
}

module.exports = { PROJECTS_KEY, persistable, decodeValue, encodeValue };
