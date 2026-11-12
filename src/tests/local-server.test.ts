import 'async';
import 'assert';
import 'should';
import * as http from 'http';
import { AddressInfo } from 'net';

import Sitemapper from '../../lib/assets/sitemapper.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

interface UrlEntry {
  loc: string;
  lastmod?: string;
}

function urlsetXml(entries: UrlEntry[]): string {
  const urls = entries
    .map(
      (entry) =>
        `<url><loc>${entry.loc}</loc>${
          entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''
        }</url>`
    )
    .join('');
  return `${XML_HEAD}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function indexXml(locs: string[]): string {
  const sitemaps = locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join('');
  return `${XML_HEAD}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps}</sitemapindex>`;
}

function activeTimeoutCount(): number {
  return (process as any)
    ._getActiveHandles()
    .filter(
      (handle: any) =>
        handle && handle.constructor && handle.constructor.name === 'Timeout'
    ).length;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Sitemapper local HTTP regression tests', function () {
  this.timeout(10000);

  let server: http.Server;
  let base: string;
  let inFlight = 0;
  let maxInFlight = 0;
  const hits: { [path: string]: number } = {};
  const sockets = new Set<any>();

  function trackHit(path: string): number {
    hits[path] = (hits[path] || 0) + 1;
    return hits[path];
  }

  async function route(path: string, res: http.ServerResponse): Promise<void> {
    const send = (body: string, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/xml' });
      res.end(body);
    };
    const page = (name: string) => urlsetXml([{ loc: `${base}/page-${name}` }]);

    // Two root indexes sharing one fast child sitemap
    if (path === '/index-a.xml') {
      return send(indexXml([`${base}/shared.xml`, `${base}/leaf-a.xml`]));
    }
    if (path === '/index-b.xml') {
      return send(indexXml([`${base}/shared.xml`, `${base}/leaf-b.xml`]));
    }
    if (path === '/shared.xml') {
      return send(page('shared'));
    }
    if (path === '/leaf-a.xml') {
      return send(page('a'));
    }
    if (path === '/leaf-b.xml') {
      return send(page('b'));
    }

    // Two root indexes sharing one slow child sitemap
    if (path === '/index-slow-a.xml') {
      return send(
        indexXml([`${base}/shared-slow.xml`, `${base}/leaf-slow-a.xml`])
      );
    }
    if (path === '/index-slow-b.xml') {
      return send(
        indexXml([`${base}/shared-slow.xml`, `${base}/leaf-slow-b.xml`])
      );
    }
    if (path === '/shared-slow.xml') {
      await delay(400);
      return send(page('shared-slow'));
    }
    if (path === '/leaf-slow-a.xml') {
      return send(page('slow-a'));
    }
    if (path === '/leaf-slow-b.xml') {
      return send(page('slow-b'));
    }

    // Slower than the test timeout budget
    if (path === '/slow.xml') {
      await delay(500);
      return send(page('slow'));
    }

    // One good child and one 404 child
    if (path === '/index-partial.xml') {
      return send(indexXml([`${base}/missing.xml`, `${base}/leaf-good.xml`]));
    }
    if (path === '/leaf-good.xml') {
      return send(page('good'));
    }
    if (path === '/missing.xml') {
      return send('not found', 404);
    }

    // Fails with a 404 (not retried internally by got) until the third hit
    if (path === '/flaky.xml') {
      const attempt = trackHit(path);
      if (attempt < 3) {
        return send('flaky failure', 404);
      }
      return send(page('flaky'));
    }

    // Nested indexes for the tree-wide concurrency test
    if (path === '/nested-index.xml') {
      return send(indexXml([`${base}/sub-1.xml`, `${base}/sub-2.xml`]));
    }
    const subMatch = path.match(/^\/sub-(\d)\.xml$/);
    if (subMatch) {
      const leaves = [1, 2, 3].map(
        (n) => `${base}/leaf-${subMatch[1]}-${n}.xml`
      );
      return send(indexXml(leaves));
    }
    const leafMatch = path.match(/^\/leaf-(\d)-(\d)\.xml$/);
    if (leafMatch) {
      await delay(50);
      return send(page(`${leafMatch[1]}-${leafMatch[2]}`));
    }

    // lastmod / exclusions / fields fixture
    if (path === '/mixed.xml') {
      return send(
        urlsetXml([
          { loc: `${base}/page-new`, lastmod: '2024-06-01' },
          { loc: `${base}/page-old`, lastmod: '2020-01-01' },
          { loc: `${base}/page-excluded-new`, lastmod: '2024-06-01' },
        ])
      );
    }

    return send('unknown', 404);
  }

  before(function (done) {
    server = http.createServer((req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          inFlight--;
        }
      };
      res.on('finish', release);
      res.on('close', release);

      const path = (req.url || '').split('?')[0];
      route(path, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  after(function (done) {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(() => done());
  });

  beforeEach(function () {
    for (const key of Object.keys(hits)) {
      delete hits[key];
    }
    inFlight = 0;
    maxInFlight = 0;
  });

  describe('overlapping calls on the same instance', function () {
    it('should let concurrent fetch() calls each complete fully', async function () {
      const sitemapper = new Sitemapper();
      const [a, b] = await Promise.all([
        sitemapper.fetch(`${base}/index-a.xml`),
        sitemapper.fetch(`${base}/index-b.xml`),
      ]);

      a.errors.should.be.empty();
      b.errors.should.be.empty();
      a.sites.should.eql([`${base}/page-shared`, `${base}/page-a`]);
      b.sites.should.eql([`${base}/page-shared`, `${base}/page-b`]);
    });

    it('should isolate cancellation between calls sharing a slow child', async function () {
      const sitemapper = new Sitemapper({ timeout: 150 });
      const start = Date.now();
      const [a, b] = await Promise.all([
        sitemapper.fetch(`${base}/index-slow-a.xml`),
        sitemapper.fetch(`${base}/index-slow-b.xml`),
      ]);
      const elapsed = Date.now() - start;

      // Each call cancels its own request for the shared slow child
      a.errors.length.should.equal(1);
      b.errors.length.should.equal(1);
      a.errors[0].type.should.equal('CancelError');
      b.errors[0].type.should.equal('CancelError');
      a.errors[0].url.should.equal(`${base}/shared-slow.xml`);
      b.errors[0].url.should.equal(`${base}/shared-slow.xml`);

      // The fast branches of both calls are unaffected
      a.sites.should.eql([`${base}/page-slow-a`]);
      b.sites.should.eql([`${base}/page-slow-b`]);

      // Neither call waited for the 400ms slow response; with a shared
      // timeout table one call's timer would be cleared by the other and
      // that call would hang until the server responds.
      elapsed.should.be.lessThan(400);
    });
  });

  describe('per-call error scoping', function () {
    it('should attribute a 404 only to the failing call and branch', async function () {
      const sitemapper = new Sitemapper();
      const [partial, good] = await Promise.all([
        sitemapper.fetch(`${base}/index-partial.xml`),
        sitemapper.fetch(`${base}/index-a.xml`),
      ]);

      // The failing branch is recorded, the sibling branch is intact
      partial.errors.length.should.equal(1);
      partial.errors[0].type.should.equal('HTTPError');
      partial.errors[0].url.should.equal(`${base}/missing.xml`);
      partial.sites.should.eql([`${base}/page-good`]);

      // The concurrent call is not polluted by the other call's failure
      good.errors.should.be.empty();
      good.sites.should.eql([`${base}/page-shared`, `${base}/page-a`]);
    });
  });

  describe('timeout lifecycle', function () {
    it('should time out per call and report a CancelError', async function () {
      const sitemapper = new Sitemapper({ timeout: 100 });
      const result = await sitemapper.fetch(`${base}/slow.xml`);

      result.sites.should.be.empty();
      result.errors.length.should.equal(1);
      result.errors[0].type.should.equal('CancelError');
      result.errors[0].url.should.equal(`${base}/slow.xml`);
    });

    it('should leave no dangling timers after calls settle', async function () {
      const baseline = activeTimeoutCount();

      const timingOut = new Sitemapper({ timeout: 100 });
      await timingOut.fetch(`${base}/slow.xml`);

      const succeeding = new Sitemapper();
      await succeeding.fetch(`${base}/index-a.xml`);

      activeTimeoutCount().should.equal(baseline);
      await delay(200);
      activeTimeoutCount().should.equal(baseline);
    });
  });

  describe('retries', function () {
    it('should retry within the same call until success', async function () {
      const sitemapper = new Sitemapper({ retries: 2 });
      const result = await sitemapper.fetch(`${base}/flaky.xml`);

      result.errors.should.be.empty();
      result.sites.should.eql([`${base}/page-flaky`]);
      hits['/flaky.xml'].should.equal(3);
    });

    it('should report the error once retries are exhausted', async function () {
      const sitemapper = new Sitemapper({ retries: 1 });
      const result = await sitemapper.fetch(`${base}/flaky.xml`);

      result.sites.should.be.empty();
      result.errors.length.should.equal(1);
      result.errors[0].url.should.equal(`${base}/flaky.xml`);
      result.errors[0].retries.should.equal(1);
      hits['/flaky.xml'].should.equal(2);
    });
  });

  describe('concurrency limit', function () {
    it('should cap in-flight requests across the whole crawl tree', async function () {
      const sitemapper = new Sitemapper({ concurrency: 2 });
      const result = await sitemapper.fetch(`${base}/nested-index.xml`);

      result.errors.should.be.empty();
      result.sites.should.eql([
        `${base}/page-1-1`,
        `${base}/page-1-2`,
        `${base}/page-1-3`,
        `${base}/page-2-1`,
        `${base}/page-2-2`,
        `${base}/page-2-3`,
      ]);
      // Two nested index levels must not get a pool each
      maxInFlight.should.be.lessThanOrEqual(2);
    });
  });

  describe('consecutive runs', function () {
    it('should produce identical results on repeated fetch() calls', async function () {
      const sitemapper = new Sitemapper();
      const first = await sitemapper.fetch(`${base}/index-a.xml`);
      const second = await sitemapper.fetch(`${base}/index-a.xml`);

      first.errors.should.be.empty();
      second.errors.should.be.empty();
      second.sites.should.eql(first.sites);
    });
  });

  describe('preserved options behavior', function () {
    it('should keep fields, lastmod and exclusions filtering intact', async function () {
      const sitemapper = new Sitemapper({
        fields: { loc: true, lastmod: true },
        lastmod: new Date('2024-01-01').getTime(),
        exclusions: [/excluded/],
      });
      const result = await sitemapper.fetch(`${base}/mixed.xml`);

      result.errors.should.be.empty();
      result.sites.should.eql([
        { loc: `${base}/page-new`, lastmod: '2024-06-01' },
      ]);
    });
  });
});
