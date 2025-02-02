/*
 * Copyright 2018-20 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from 'debug'
import { join } from 'path'
import needle, { BodyData } from 'needle'
import { Arguments, ExecOptions, REPL, inBrowser, hasProxy, encodeComponent, i18n } from '@kui-shell/core'

import JSONStream from './json'
import getProxyState from '../../controller/client/proxy'
import { KubeOptions, isRecursive } from '../../controller/kubectl/options'

const strings = i18n('plugin-kubectl')
const debug = Debug('plugin-kubectl/util/fetch-file')

/** Maximum number of times to retry on ECONNREFUSED */
const MAX_ECONNREFUSED_RETRIES = 10

const httpScheme = /http(s)?:\/\//
const kubernetesScheme = /^kubernetes:\/\//

/** Instantiate a kubernetes:// scheme with the current kubectl proxy state */
async function rescheme(url: string): Promise<string> {
  if (kubernetesScheme.test(url)) {
    const { baseUrl } = await getProxyState()
    return url.replace(kubernetesScheme, baseUrl)
  } else {
    return url
  }
}

export interface ObjectStream<T extends object> {
  on(evt: 'data', cb: (obj: T) => void)
  on(evt: 'done', cb: () => void)
}

export async function openStream<T extends object>(
  args: Pick<Arguments, 'REPL'>,
  url: string,
  mgmt: Pick<ExecOptions, 'onInit' | 'onReady' | 'onExit'>,
  headers?: Record<string, string>
) {
  if (inBrowser() && hasProxy()) {
    debug('routing openStream request to proxy', url)
    await args.REPL.rexec(
      `_openstream ${encodeComponent(url)}`,
      Object.assign(
        {},
        {
          onInit: mgmt.onInit,
          onReady: mgmt.onReady,
          onExit: mgmt.onExit,
          data: { headers }
        }
      )
    )
    debug('routed openStream to proxy: done', url)
  } else {
    // we need to set JSON to false to disable needle's parsing, which
    // seems not to be compatible with streaming
    const uri = await rescheme(url)
    debug('routing openStream request to endpoint', uri)
    const stream = needle.get(uri, { headers, parse: false })
    const onData = mgmt.onInit({
      abort: () => {
        debug('abort requested', typeof stream['destroy'])
        if (typeof stream['destroy'] === 'function') {
          stream['destroy']()
        }

        if (typeof mgmt.onExit === 'function') {
          debug('sending onExit')
          mgmt.onExit(0)
        }
      },
      xon: () => stream.resume(),
      xoff: () => stream.pause(),
      write: () => {
        console.error('Unsupported Operation: write')
      }
    })

    JSONStream(stream, await onData, mgmt.onExit)
  }
}

interface FetchOptions<Data extends BodyData | BodyData[]> {
  returnErrors?: boolean
  data?: Data
  headers?: Record<string, string>
  method?: 'get' | 'put' | 'post' | 'delete'
}

export async function _needle(
  repl: Pick<REPL, 'rexec'>,
  url: string,
  opts?: FetchOptions<BodyData>,
  retryCount = 0
): Promise<{ statusCode: number; body: string | object }> {
  if (!inBrowser()) {
    const method = (opts && opts.method) || 'get'
    const headers = Object.assign({ connection: 'keep-alive' }, opts.headers)
    debug('fetch via needle', method, headers)
    try {
      const { statusCode, body } = await needle(method, await rescheme(url), opts.data, {
        json: true,
        follow_max: 10,
        headers
      })
      debug('fetch via needle done', statusCode)
      return { statusCode, body }
    } catch (err) {
      if (err.code === 'ECONNREFUSED' && retryCount < MAX_ECONNREFUSED_RETRIES) {
        // then the proxy is probably transiently offline, e.g. due to
        // switching context or namespace
        debug('retrying due to ECONNREFUSED')
        return new Promise((resolve, reject) => {
          setTimeout(async () => {
            try {
              _needle(repl, url, opts, retryCount + 1).then(resolve, reject)
            } catch (err) {
              reject(err)
            }
          }, 50)
        })
      } else {
        throw err
      }
    }
  } else if (inBrowser()) {
    // Unfortunately, we cannot rely on being able to fetch files
    // directly from a browser. For one, if the remote site does not
    // offer an Access-Control-Allow-Origin, then well behaving
    // browsers will refuse to load their content;
    // e.g. https://k8s.io/examples/controllers/nginx-deployment.yaml
    // Solution: have the kui proxy do this
    if (!hasProxy()) {
      throw new Error(strings('Unable to fetch remote file'))
    } else {
      debug('fetch via proxy')
      const body = (await repl.rexec<(string | object)[]>(`_fetchfile ${encodeComponent(url)}`, { data: opts }))
        .content[0]
      return {
        statusCode: 200,
        body
      }
    }
  }
}

async function fetchRemote(repl: REPL, url: string, opts?: FetchOptions<BodyData>) {
  debug('fetchRemote', url, opts)
  const fetchOnce = () => _needle(repl, url, opts).then(_ => _.body)

  const retry = (delay: number) => async (err: Error) => {
    if (/timeout/.test(err.message) || /hang up/.test(err.message) || /hangup/.test(err.message)) {
      debug('retrying', err)
      await new Promise(resolve => setTimeout(resolve, delay))
      return fetchOnce()
    } else {
      throw err
    }
  }

  // fetch with three retries
  return fetchOnce()
    .catch(retry(500))
    .catch(retry(1000))
    .catch(retry(5000))
}

export type ReturnedError = {
  error: Error
}

export type FetchedFile = string | Buffer | object | ReturnedError

export function isReturnedError(file: FetchedFile): file is ReturnedError {
  const err = file as ReturnedError
  return typeof file !== 'string' && !Buffer.isBuffer(file) && typeof err.error === 'object'
}

/**
 * Either fetch a remote file or read a local one
 *
 */
export async function fetchFile(
  repl: REPL,
  url: string,
  opts?: FetchOptions<BodyData | BodyData[]>
): Promise<FetchedFile[]> {
  const urls = url.split(/,/)
  debug('fetchFile', urls)
  const start = Date.now()

  const responses = await Promise.all(
    urls.map(async (url, idx) => {
      if (httpScheme.test(url) || kubernetesScheme.test(url)) {
        debug('fetch remote', url)
        return fetchRemote(
          repl,
          url,
          Object.assign({}, opts, { data: Array.isArray(opts.data) ? opts.data[idx] : opts.data })
        ).catch(err => {
          if (opts && opts.returnErrors) {
            return { error: err }
          } else throw err
        })
      } else {
        const filepath = url
        debug('fetch local', filepath)
        const stats = (await repl.rexec<{ data: string }>(`vfs fstat ${repl.encodeComponent(filepath)} --with-data`))
          .content
        return stats.data
      }
    })
  )

  debug('fetchFile done', Date.now() - start)
  return responses
}

/** same as fetchFile, but returning a string rather than a Buffer */
export async function fetchFileString(
  repl: REPL,
  url: string,
  headers?: Record<string, string>
): Promise<(void | string)[]> {
  const files = await fetchFile(repl, url, { headers })
  return files.map(_ => {
    try {
      return _ ? _.toString() : undefined
    } catch (err) {
      console.error('Unable to convert fetched file to string', err, _)
      return ''
    }
  })
}

export async function fetchFileKustomize(repl: REPL, url: string): Promise<{ data: string; dir?: string }> {
  const stats = (
    await repl.rexec<{ data: string; dir?: string }>(`_fetchfile ${repl.encodeComponent(url)} --kustomize`)
  ).content
  return stats
}

/**
 * fetch raw files from `filepath`
 */
export async function fetchRawFiles(args: Arguments<KubeOptions>, filepath: string) {
  if (filepath.match(/http(s)?:\/\//)) {
    return fetchRemote(args.REPL, filepath)
  } else {
    const path = args.REPL.encodeComponent(filepath)
    const resourceStats = (
      await args.REPL.rexec<{ data?: string; isDirectory?: boolean }>(`vfs fstat ${path} --with-data`)
    ).content

    if (resourceStats.isDirectory) {
      return args.REPL.rexec<{ path: string }[]>(
        `vfs ls ${join(path, isRecursive(args) ? '/**/*.yaml' : '/*.yaml')} --with-data`
      )
        .then(_ => _.content)
        .then(filenames =>
          Promise.all(
            filenames.map(({ path }) =>
              args.REPL.rexec<{ data: string }>(`vfs fstat ${path} --with-data`).then(_ => _.content.data)
            )
          )
        )
        .then(_ => _.join('---\n'))
    } else {
      return resourceStats.data
    }
  }
}

export default fetchFileString
