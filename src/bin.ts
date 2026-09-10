#!/usr/bin/env node

import { main } from "./cli.js";

void main().then((code) => {
  process.exitCode = code;
});
