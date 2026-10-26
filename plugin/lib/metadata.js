import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const PLUGIN_VERSION = manifest.version;
export const SUPPORTED_HARNESS = manifest.engines.dsh;
