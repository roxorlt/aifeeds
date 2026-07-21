#!/usr/bin/env node

import { verifyHomeBuildIdentity } from "./home-build-identity.mjs";
import { fileURLToPath } from "node:url";

const identity = await verifyHomeBuildIdentity(fileURLToPath(new URL("../dist/", import.meta.url)));
process.stdout.write(`home_build_identity=${identity.slice(0, 12)}...\n`);
