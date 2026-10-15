#!/usr/bin/env node
/**
 * Runtime Route Inventory Snapshot.
 * Boots createApp() WITHOUT binding a port and prints a sorted JSON array of
 * "METHOD /full/path" strings. Works for both Express 4 and Fastify apps so the
 * same command verifies every intermediate migration state.
 */
import { register } from 'tsx/esm/api';

register();

const { createApp } = await import('../src/app.ts');

const normalize = (p) => {
  const collapsed = ('/' + p).replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
};

/** Express 4: walk app._router.stack, resolving mount prefixes from layer regexps. */
function expressRoutes(app) {
  const out = new Set();
  const prefixOf = (layer) => {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    const src = layer.regexp.source
      .replace('^\\/', '/')
      .replace('\\/?(?=\\/|$)', '')
      .replace(/\\\//g, '/');
    return src.replace(/[\^$]/g, '');
  };
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          out.add(`${method.toUpperCase()} ${normalize(prefix + layer.route.path)}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + prefixOf(layer));
      }
    }
  };
  walk(app._router?.stack ?? [], '');
  return out;
}

/** Fastify: collect routes through an onRoute hook, then app.ready(). */
async function fastifyRoutes(app) {
  const out = new Set();
  app.addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      out.add(`${m} ${normalize(opts.url)}`);
    }
  });
  await app.ready();
  await app.close();
  return out;
}

// NOTE: Fastify instances are thenable; awaiting one triggers ready() and seals
// the instance before onRoute can attach. Only await real (non-Fastify) promises.
const isFastifyInstance = (x) => typeof x?.inject === 'function' && typeof x?.register === 'function';
const created = createApp();
const app = isFastifyInstance(created) ? created : await created;
const isFastify = isFastifyInstance(app);
const routes = isFastify ? await fastifyRoutes(app) : expressRoutes(app);

process.stdout.write(JSON.stringify([...routes].sort()) + '\n');
