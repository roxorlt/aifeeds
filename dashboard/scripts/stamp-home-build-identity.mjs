#!/usr/bin/env node

import { stampHomeBuildIdentity } from "./home-build-identity.mjs";
import { fileURLToPath } from "node:url";

const identity = await stampHomeBuildIdentity(fileURLToPath(new URL("../dist/", import.meta.url)));
process.stdout.write(`stamped_home_build_identity=${identity.slice(0, 12)}...\n`);
