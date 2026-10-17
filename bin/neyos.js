#!/usr/bin/env node
import { main } from "../src/neyos.js";

main(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
});
