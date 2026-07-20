#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BEGIN = '# AIFEEDS-CC-CONTENT-MIRROR-BEGIN';
const END = '# AIFEEDS-CC-CONTENT-MIRROR-END';
const INCLUDE = (
  'include /www/server/panel/vhost/nginx/'
  + 'aifeeds-cc-content-mirror.conf;'
);

function structuralView(source) {
  let state = 'code';
  let escaped = false;
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (state === 'comment') {
      if (char === '\n') {
        state = 'code';
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && char === "'")
        || (state === 'double' && char === '"')
      ) {
        state = 'code';
      }
      result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (char === '#') {
      state = 'comment';
      result += ' ';
    } else if (char === "'") {
      state = 'single';
      result += ' ';
    } else if (char === '"') {
      state = 'double';
      result += ' ';
    } else {
      result += char;
    }
  }
  return result;
}

function serverBlocks(source) {
  const view = structuralView(source);
  const blocks = [];
  let depth = 0;
  let pendingServer = null;
  let active = null;

  for (let index = 0; index < view.length;) {
    const char = view[index];
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < view.length && /[A-Za-z0-9_-]/.test(view[end])) end += 1;
      if (depth === 0 && view.slice(index, end) === 'server') {
        pendingServer = index;
      }
      index = end;
      continue;
    }
    if (char === '{') {
      if (depth === 0 && pendingServer !== null) {
        active = { start: pendingServer, open: index };
      }
      depth += 1;
      pendingServer = null;
    } else if (char === '}') {
      if (depth <= 0) throw new Error('invalid Nginx brace structure');
      depth -= 1;
      if (depth === 0 && active !== null) {
        blocks.push({ ...active, close: index, end: index + 1 });
        active = null;
      }
      pendingServer = null;
    } else if (!/\s/.test(char)) {
      pendingServer = null;
    }
    index += 1;
  }
  if (depth !== 0 || active !== null) {
    throw new Error('invalid Nginx brace structure');
  }
  return blocks;
}

function directiveValues(block, name) {
  const pattern = new RegExp(`^\\s*${name}\\s+([^;]+);`, 'gm');
  return [...block.matchAll(pattern)].map((match) => match[1].trim());
}

function isTargetServer(block) {
  const listensOn443 = directiveValues(block, 'listen').some((value) => (
    /^(?:(?:\[[^\]]+\]|[^\s:]+):)?443(?:\s|$)/.test(value)
  ));
  const hasSiteName = directiveValues(block, 'server_name').some((value) => (
    value.split(/\s+/).includes('ai-feeds.cc')
  ));
  return listensOn443 && hasSiteName;
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function canonicalManagedBlock(indent) {
  return [
    `${indent}${BEGIN}`,
    `${indent}${INCLUDE}`,
    `${indent}${END}`,
  ].join('\n');
}

function depthAt(view, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (view[index] === '{') depth += 1;
    if (view[index] === '}') depth -= 1;
  }
  return depth;
}

function topLevelRegexLocations(block) {
  const view = structuralView(block);
  const offsets = [];
  let depth = 0;
  for (let index = 0; index < view.length;) {
    if (view[index] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (view[index] === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0 && view.startsWith('location', index)) {
      const before = index === 0 ? ' ' : view[index - 1];
      const after = view[index + 'location'.length] ?? ' ';
      if (!/[A-Za-z0-9_-]/.test(before) && /\s/.test(after)) {
        let modifier = index + 'location'.length;
        while (/\s/.test(view[modifier] ?? '')) modifier += 1;
        if (view[modifier] === '~') offsets.push(index);
      }
    }
    index += 1;
  }
  return offsets;
}

function rewriteContract(source, target) {
  const targetBody = source.slice(target.open + 1, target.close);
  const rewriteMarkers = [...targetBody.matchAll(/^[ \t]*#REWRITE-END[ \t]*$/gm)];
  const view = structuralView(targetBody);
  if (
    rewriteMarkers.length !== 1
    || depthAt(view, rewriteMarkers[0].index) !== 0
  ) {
    throw new Error('expected exactly one top-level Nginx rewrite marker');
  }
  const marker = rewriteMarkers[0];
  const markerStart = target.open + 1 + marker.index;
  const regexLocations = topLevelRegexLocations(targetBody)
    .map((offset) => target.open + 1 + offset);
  if (regexLocations.some((offset) => offset < markerStart)) {
    throw new Error('rewrite marker must precede every top-level regex location');
  }
  return { marker, markerStart, regexLocations };
}

function newManagedBlockInsertion(source, target, contract) {
  const markerLineEnd = source.indexOf('\n', contract.markerStart);
  if (markerLineEnd === -1 || markerLineEnd >= target.close) {
    throw new Error('invalid Nginx rewrite marker placement');
  }
  const indent = contract.marker[0].match(/^[ \t]*/)[0];
  return {
    index: markerLineEnd + 1,
    contents: `${canonicalManagedBlock(indent)}\n`,
  };
}

export function injectManagedInclude(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('Nginx vhost source is required');
  }
  const blocks = serverBlocks(source);
  const targets = blocks.filter((candidate) => isTargetServer(
    source.slice(candidate.open + 1, candidate.close),
  ));
  if (targets.length !== 1) {
    throw new Error('expected exactly one HTTPS ai-feeds.cc server block');
  }
  const target = targets[0];
  const contract = rewriteContract(source, target);
  const beginCount = countOccurrences(source, BEGIN);
  const endCount = countOccurrences(source, END);
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error('incomplete managed include markers');
  }

  if (beginCount === 0) {
    if (source.includes(INCLUDE)) {
      throw new Error('unmanaged content mirror include');
    }
    const insertion = newManagedBlockInsertion(source, target, contract);
    return (
      source.slice(0, insertion.index)
      + insertion.contents
      + source.slice(insertion.index)
    );
  }

  if (countOccurrences(source, INCLUDE) !== 1) {
    throw new Error('unmanaged content mirror include');
  }

  const beginIndex = source.indexOf(BEGIN);
  const endIndex = source.indexOf(END);
  if (
    beginIndex < target.open
    || endIndex > target.close
    || endIndex < beginIndex
  ) {
    throw new Error('managed include is outside the HTTPS site block');
  }
  if (
    beginIndex < contract.markerStart
    || contract.regexLocations.some((offset) => offset < beginIndex)
  ) {
    throw new Error('managed include must precede every top-level regex location');
  }
  const blockLineStart = source.lastIndexOf('\n', beginIndex - 1) + 1;
  const afterEnd = source.indexOf('\n', endIndex);
  const blockEnd = afterEnd === -1 ? source.length : afterEnd;
  const indent = source.slice(blockLineStart, beginIndex);
  const existing = source.slice(blockLineStart, blockEnd);
  if (countOccurrences(existing, INCLUDE) !== 1) {
    throw new Error('invalid managed include block');
  }
  return (
    source.slice(0, blockLineStart)
    + canonicalManagedBlock(indent)
    + source.slice(blockEnd)
  );
}

const isMain = Boolean(
  process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]),
);

if (isMain) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: nginx-vhost-editor.mjs <input> <output>');
    process.exitCode = 2;
  } else {
    try {
      const source = await readFile(input, 'utf8');
      const edited = injectManagedInclude(source);
      await writeFile(output, edited, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

export { BEGIN, END, INCLUDE };
