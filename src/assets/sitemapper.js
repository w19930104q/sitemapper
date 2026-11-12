/**
 * Sitemap Parser
 *
 * Copyright (c) 2024 Sean Thomas Burke
 * Licensed under the MIT license.
 * @author Sean Burke <@seantomburke>
 */

import { XMLParser } from 'fast-xml-parser';
import got from 'got';
import zlib from 'zlib';
import pLimit from 'p-limit';

/**
 * @typedef {Object} Sitemapper
 */
export default class Sitemapper {
  /**
   * Construct the Sitemapper class
   *
   * @params {Object} options to set
   * @params {string} [options.url] - the Sitemap url (e.g https://wp.seantburke.com/sitemap.xml)
   * @params {Timeout} [options.timeout] - @see {timeout}
   * @params {boolean} [options.debug] - Enables/Disables additional logging
   * @params {integer} [options.concurrency] - The number of concurrent sitemaps to crawl (e.g. 2 will crawl no more than 2 sitemaps at the same time)
   * @params {integer} [options.retries] - The maximum number of retries to attempt when crawling fails (e.g. 1 for 1 retry, 2 attempts in total)
   * @params {boolean} [options.rejectUnauthorized] - If true (default), it will throw on invalid certificates, such as expired or self-signed ones.
   * @params {lastmod} [options.lastmod] - the minimum lastmod value for urls
   * @params {hpagent.HttpProxyAgent|hpagent.HttpsProxyAgent} [options.proxyAgent] - instance of npm "hpagent" HttpProxyAgent or HttpsProxyAgent to be passed to npm "got"
   * @params {Array<RegExp>} [options.exclusions] - Array of regex patterns to exclude URLs
   *
   * @example let sitemap = new Sitemapper({
   *   url: 'https://wp.seantburke.com/sitemap.xml',
   *   timeout: 15000,
   *   lastmod: 1630693759,
   *   exclusions: [/foo.com/, /bar.xml/] // Filters out URLs matching these patterns
   *  });
   */
  constructor(options) {
    const settings = options || { requestHeaders: {} };
    this.url = settings.url;
    this.timeout = settings.timeout || 15000;
    this.lastmod = settings.lastmod || 0;
    this.requestHeaders = settings.requestHeaders;
    this.debug = settings.debug;
    this.concurrency = settings.concurrency || 10;
    this.retries = settings.retries || 0;
    this.rejectUnauthorized =
      settings.rejectUnauthorized === false ? false : true;
    this.fields = settings.fields || false;
    this.proxyAgent = settings.proxyAgent || {};
    this.exclusions = settings.exclusions || [];
  }

  /**
   * Gets the sites from a sitemap.xml with a given URL
   *
   * @public
   * @param {string} [url] - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @returns {Promise<SitesData>}
   * @example sitemapper.fetch('example.xml')
   *  .then((sites) => console.log(sites));
   */
  async fetch(url = this.url) {
    // initialize empty variables
    let results = {
      url: '',
      sites: [],
      errors: [],
    };

    // attempt to set the variables with the crawl
    if (this.debug) {
      // only show if it's set
      if (this.lastmod) {
        console.debug(`Using minimum lastmod value of ${this.lastmod}`);
      }
    }

    try {
      // Each fetch() call gets its own crawl context so that timeout, retry
      // and cancellation lifecycles never leak between concurrent calls, and
      // so the concurrency limiter covers every HTTP request in the tree.
      const context = { limit: pLimit(this.concurrency) };

      // crawl the URL
      results = await this.crawl(url, 0, context);
    } catch (e) {
      // show errors that may occur
      if (this.debug) {
        console.error(e);
      }
    }

    return {
      url,
      sites: results.sites || [],
      errors: results.errors || [],
    };
  }

  /**
   * Get the timeout
   *
   * @example console.log(sitemapper.timeout);
   * @returns {Timeout}
   */
  static get timeout() {
    return this.timeout;
  }

  /**
   * Set the timeout
   *
   * @public
   * @param {Timeout} duration
   * @example sitemapper.timeout = 15000; // 15 seconds
   */
  static set timeout(duration) {
    this.timeout = duration;
  }

  /**
   * Get the lastmod minimum value
   *
   * @example console.log(sitemapper.lastmod);
   * @returns {number}
   */
  static get lastmod() {
    return this.lastmod;
  }

  /**
   * Set the lastmod minimum value
   *
   * @public
   * @param {number} timestamp
   * @example sitemapper.lastmod = 1630694181; // Unix timestamp
   */
  static set lastmod(timestamp) {
    this.lastmod = timestamp;
  }

  /**
   *
   * @param {string} url - url for making requests. Should be a link to a sitemaps.xml
   * @example sitemapper.url = 'https://wp.seantburke.com/sitemap.xml'
   */
  static set url(url) {
    this.url = url;
  }

  /**
   * Get the url to parse
   * @returns {string}
   * @example console.log(sitemapper.url)
   */
  static get url() {
    return this.url;
  }

  /**
   * Setter for the debug state
   * @param {boolean} option - set whether to show debug logs in output.
   * @example sitemapper.debug = true;
   */
  static set debug(option) {
    this.debug = option;
  }

  /**
   * Getter for the debug state
   * @returns {boolean}
   * @example console.log(sitemapper.debug)
   */
  static get debug() {
    return this.debug;
  }

  /**
   * Requests the URL and uses fast-xml-parser to parse through and find the data
   *
   * @private
   * @param {string} [url] - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @returns {Promise<ParseData>}
   */
  async parse(url = this.url) {
    // setup the response options for the got request
    const requestOptions = {
      method: 'GET',
      decompress: true,
      responseType: 'buffer',
      headers: this.requestHeaders,
      https: {
        rejectUnauthorized: this.rejectUnauthorized,
      },
      agent: this.proxyAgent,
    };

    // create a request Promise with the url and request options
    const requester = got.get(url, requestOptions);

    // initialize the timeout for this specific request only. The timer is
    // local to this call, so concurrent fetches of the same URL can never
    // clear or cancel each other's requests.
    const timeout = this.initializeTimeout(url, requester);

    try {
      // get the response from the requester promise
      const response = await requester;

      // if the response does not have a successful status code then report it.
      if (!response || response.statusCode !== 200) {
        const statusCode = response ? response.statusCode : 0;
        const statusMessage = response ? response.statusMessage : 'No response';
        return {
          error: `HTTP Error: ${statusCode} ${statusMessage}`,
          data: response,
        };
      }

      // got's decompress option handles HTTP Content-Encoding (e.g. gzip),
      // but raw .gz files served without Content-Encoding need manual decompression.
      let responseBody = response.body;
      if (
        response.body.length > 2 &&
        response.body[0] === 0x1f &&
        response.body[1] === 0x8b
      ) {
        responseBody = zlib.gunzipSync(response.body);
      }

      // Parse XML using fast-xml-parser
      const parser = new XMLParser({
        isArray: (tagName) =>
          ['sitemap', 'url'].some((value) => value === tagName),
        removeNSPrefix: true,
      });

      const data = parser.parse(responseBody.toString());

      // return the results
      return { error: null, data };
    } catch (error) {
      // If the request was canceled notify the user of the timeout
      if (error.name === 'CancelError') {
        return {
          error: `Request timed out after ${this.timeout} milliseconds for url: '${url}'`,
          data: error,
        };
      }

      // If an HTTPError include error http code
      if (error.name === 'HTTPError') {
        return {
          error: `HTTP Error occurred: ${error.message}`,
          data: error,
        };
      }

      // Otherwise notify of another error
      return {
        error: `Error occurred: ${error.name}`,
        data: error,
      };
    } finally {
      // Always clear this request's own timer so no dangling timers remain
      // after the call settles, regardless of success, error or cancellation.
      clearTimeout(timeout);
    }
  }

  /**
   * Timeouts are necessary for large xml trees. This will cancel the call if the request is taking
   * too long, but will still allow the promises to resolve.
   *
   * @private
   * @param {string} url - url of the request being timed
   * @param {Promise} requester - the promise that creates the web request to the url
   * @returns {Timeout} the timer handle, owned by the caller, which must be
   * cleared once the request settles
   */
  initializeTimeout(url, requester) {
    // this will throw a CancelError which will be handled in the parent that calls this method.
    return setTimeout(() => requester.cancel(), this.timeout);
  }

  /**
   * Recursive function that will go through a sitemaps tree and get all the sites
   *
   * @private
   * @param {string} url - the Sitemaps url (e.g https://wp.seantburke.com/sitemap.xml)
   * @param {integer} retryIndex - number of retry attempts fro this URL (e.g. 0 for 1st attempt, 1 for second attempty etc.)
   * @param {Object} [context] - per-fetch() crawl context carrying the shared
   * concurrency limiter. When omitted (direct calls), a fresh context is
   * created so the call still has its own lifecycle.
   * @returns {Promise<SitesData>}
   */
  async crawl(url, retryIndex = 0, context) {
    // The limiter is shared by the whole crawl tree of a single fetch() call,
    // so the concurrency cap applies to all actual HTTP requests in the tree
    // rather than each sitemap index level getting its own pool.
    const activeContext = context || { limit: pLimit(this.concurrency) };
    try {
      // Only the HTTP request itself holds a limiter slot. The slot is
      // released before child sitemaps are crawled, which both caps the
      // number of in-flight requests tree-wide and prevents nested sitemap
      // indexes from deadlocking when concurrency is low.
      const { error, data } = await activeContext.limit(() => this.parse(url));

      if (error) {
        // Handle errors during sitemap parsing / request
        // Retry on error until you reach the retry limit set in the settings
        if (retryIndex < this.retries) {
          if (this.debug) {
            console.log(
              `(Retry attempt: ${retryIndex + 1} / ${
                this.retries
              }) ${url} due to ${data.name} on previous request`
            );
          }
          return this.crawl(url, retryIndex + 1, activeContext);
        }

        if (this.debug) {
          console.error(
            `Error occurred during "crawl('${url}')":\n\r Error: ${error}`
          );
        }

        // Fail and log error
        return {
          sites: [],
          errors: [
            {
              type: data.name,
              message: error,
              url,
              retries: retryIndex,
            },
          ],
        };
      } else if (data && data.urlset && data.urlset.url) {
        // Handle URLs found inside the sitemap
        if (this.debug) {
          console.debug(`Urlset found during "crawl('${url}')"`);
        }

        // Convert single object to array if needed
        const urlArray = Array.isArray(data.urlset.url)
          ? data.urlset.url
          : [data.urlset.url];

        // Begin filtering the urls
        const sites = urlArray
          .filter((site) => {
            if (this.lastmod === 0) return true;
            if (site.lastmod === undefined) return false;
            const modified = new Date(site.lastmod).getTime();

            return modified >= this.lastmod;
          })
          .filter((site) => {
            return !this.isExcluded(site.loc);
          })
          .map((site) => {
            if (!this.fields) {
              return site.loc;
            } else {
              let fields = {};
              if (this.fields.sitemap) {
                fields.sitemap = url;
              }
              for (const [field, active] of Object.entries(this.fields)) {
                if (active && site[field]) {
                  fields[field] = site[field];
                }
              }
              return fields;
            }
          });

        return {
          sites,
          errors: [],
        };
      } else if (data && data.sitemapindex) {
        // Handle child sitemaps found inside the active sitemap
        if (this.debug) {
          console.debug(`Additional sitemap found during "crawl('${url}')"`);
        }
        // Map each child url into a promise to create an array of promises
        const sitemap = data.sitemapindex.sitemap
          .map((map) => map.loc)
          .filter((url) => {
            return !this.isExcluded(url);
          });

        // Crawl all child urls. Each child acquires a limiter slot around its
        // own HTTP request, so the shared limiter caps requests across the
        // whole tree, including deeper index levels.
        const promiseArray = sitemap.map((site) =>
          this.crawl(site, 0, activeContext)
        );

        // Make sure all the promises resolve then filter and reduce the array
        const results = await Promise.all(promiseArray);
        const sites = results
          .filter((result) => result.errors.length === 0)
          .reduce((prev, { sites }) => [...prev, ...sites], []);
        const errors = results
          .filter((result) => result.errors.length !== 0)
          .reduce((prev, { errors }) => [...prev, ...errors], []);

        return {
          sites,
          errors,
        };
      }

      // Retry on error until you reach the retry limit set in the settings
      if (retryIndex < this.retries) {
        if (this.debug) {
          console.log(
            `(Retry attempt: ${retryIndex + 1} / ${
              this.retries
            }) ${url} due to ${data.name} on previous request`
          );
        }
        return this.crawl(url, retryIndex + 1, activeContext);
      }
      if (this.debug) {
        console.error(`Unknown state during "crawl('${url})'":`, error, data);
      }

      // Fail and log error
      return {
        sites: [],
        errors: [
          {
            url,
            type: data.name || 'UnknownStateError',
            message: 'An unknown error occurred.',
            retries: retryIndex,
          },
        ],
      };
    } catch (e) {
      if (this.debug) {
        this.debug && console.error(e);
      }
    }
  }

  /**
   * Gets the sites from a sitemap.xml with a given URL
   *
   * @deprecated
   * @param {string} url - url to query
   * @param {getSitesCallback} callback - callback for sites and error
   * @callback
   */
  async getSites(url = this.url, callback) {
    console.warn(
      '\r\nWarning:',
      'function .getSites() is deprecated, please use the function .fetch()\r\n'
    );

    let err = {};
    let sites = [];
    try {
      const response = await this.fetch(url);
      sites = response.sites;
    } catch (error) {
      err = error;
    }
    return callback(err, sites);
  }

  /**
   * Checks if a urls is excluded based on the exclusion patterns.
   *
   * @param {string} url - The URL to check.
   * @returns {boolean} Returns true if the urls is excluded, false otherwise.
   */
  isExcluded(url) {
    if (this.exclusions.length === 0) return false;
    return this.exclusions.some((pattern) => pattern.test(url));
  }
}

/**
 * Callback for the getSites method
 *
 * @callback getSitesCallback
 * @param {Object} error - error from callback
 * @param {Array} sites - an Array of sitemaps
 */

/**
 * Timeout in milliseconds
 *
 * @typedef {number} Timeout
 * the number of milliseconds before all requests timeout. The promises will still resolve so
 * you'll still receive parts of the request, but maybe not all urls
 * default is 15000 which is 15 seconds
 */

/**
 * Resolve handler type for the promise in this.parse()
 *
 * @typedef {Object} ParseData
 *
 * @property {Error} error that either comes from fast-xml-parser or `got` or custom error
 * @property {Object} data
 * @property {string} data.url - URL of sitemap
 * @property {Array} data.urlset - Array of returned URLs
 * @property {string} data.urlset.url - single Url
 * @property {Object} data.sitemapindex - index of sitemap
 * @property {string} data.sitemapindex.sitemap - Sitemap
 * @example {
 *   error: 'There was an error!'
 *   data: {
 *     url: 'https://linkedin.com',
 *     urlset: [{
 *       url: 'https://www.linkedin.com/project1'
 *     },[{
 *       url: 'https://www.linkedin.com/project2'
 *     }]
 *   }
 * }
 */

/**
 * Resolve handler type for the promise in this.parse()
 *
 * @typedef {Object} SitesData
 *
 * @property {string} url - the original url used to query the data
 * @property {SitesArray} sites
 * @property {ErrorDataArray} errors
 * @example {
 *   url: 'https://linkedin.com/sitemap.xml',
 *   sites: [
 *     'https://linkedin.com/project1',
 *     'https://linkedin.com/project2'
 *   ],
 *   errors: [
 *      {
 *        type: 'CancelError',
 *        url: 'https://www.walmart.com/sitemap_tp1.xml',
 *        retries: 0
 *      },
 *      {
 *        type: 'HTTPError',
 *        url: 'https://www.walmart.com/sitemap_tp2.xml',
 *        retries: 0
 *      },
 *   ]
 * }
 */

/**
 * An array of urls
 *
 * @typedef {string[]} SitesArray
 * @example [
 *   'https://www.google.com',
 *   'https://www.linkedin.com'
 * ]
 */

/**
 * An array of Error data objects
 *
 * @typedef {ErrorData[]} ErrorDataArray
 * @example [
 *    {
 *      type: 'CancelError',
 *      url: 'https://www.walmart.com/sitemap_tp1.xml',
 *      retries: 0
 *    },
 *    {
 *      type: 'HTTPError',
 *      url: 'https://www.walmart.com/sitemap_tp2.xml',
 *      retries: 0
 *    },
 * ]
 */

/**
 * An object containing details about the errors which occurred during the crawl
 *
 * @typedef {Object} ErrorData
 *
 * @property {string} type - The error type which was returned
 * @property {string} url - The sitemap URL which returned the error
 * @property {number} errors - The total number of retries attempted after receiving the first error
 * @example {
 *    type: 'CancelError',
 *    url: 'https://www.walmart.com/sitemap_tp1.xml',
 *    retries: 0
 * }
 */
