/*
 * Copyright 2020 IBM Corporation
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
import { basename, join } from 'path'
import * as micromatch from 'micromatch'
import { Client, CopyConditions } from 'minio'
import { Arguments, CodedError, REPL, encodeComponent, flatten, i18n } from '@kui-shell/core'
import { DirEntry, FStat, GlobStats, ParallelismOptions, VFS, mount } from '@kui-shell/plugin-bash-like/fs'

import { username, uid, gid } from './username'
import findAvailableProviders, { Provider } from '../providers'

import S3VFS, { S3_TAG } from './S3VFS'
import setResponders from './responders'
import JobProvider, { JobEnv } from '../jobs'
import ParallelOperation from './parallel/operations'
import CodeEngine from '../jobs/providers/CodeEngine'
import runWithProgress, { runWithLogs } from '../ssc/scaleOut'

const strings = i18n('plugin-s3')
const debug = Debug('plugin-s3/vfs')

function isS3Provider(vfs: VFS): vfs is S3VFSResponder {
  return !!vfs && !!vfs.tags && vfs.tags.includes(S3_TAG)
}

class S3VFSResponder extends S3VFS implements VFS {
  private readonly client: Client

  public constructor(private readonly options: Provider) {
    super(options.mountName)
    this.client = new Client(options)
    debug('new s3 vfs responder', options.mountName, options.endPoint)
  }

  public async ls({ parsedOptions }: Parameters<VFS['ls']>[0], filepaths: string[]) {
    return flatten(
      await Promise.all(filepaths.map(filepath => this.dirstat(filepath.replace(this.s3Prefix, ''), parsedOptions.d)))
    )
  }

  /** Degenerate case for `ls /s3`: list all buckets */
  private async listBuckets(): Promise<DirEntry[]> {
    const buckets = await this.client.listBuckets()

    return buckets.map(({ name /* , creationDate */ }) => ({
      name,
      path: join(this.mountPath, name),
      stats: {
        size: 0,
        mtimeMs: 0,
        mode: 0,
        uid,
        gid
      },
      nameForDisplay: name,
      dirent: {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        isSpecial: false,
        isExecutable: false,
        permissions: '',
        username
      }
    }))
  }

  private async listBucketsMatching(pattern: string): Promise<DirEntry[]> {
    const allBuckets = await this.listBuckets()
    return allBuckets.filter(_ => micromatch.isMatch(_.name, pattern))
  }

  /** Enumerate matching objects */
  private async listObjects(filepath: string, dashD = false): Promise<DirEntry[]> {
    const [, bucketName, bucketNameSlash, prefix, wildcardSuffix] = filepath.match(/([^/*{]+)(\/?)([^*{]*)(.*)/)

    const pattern =
      prefix.length === 0 && (wildcardSuffix.length === 0 || wildcardSuffix === '*')
        ? '*' // e.g. ls /s3/myBucket
        : wildcardSuffix // e.g. ls /s3/myBucket/he*lo

    if (!bucketNameSlash && dashD) {
      // ls -d /s3/myBuck*
      return this.listBucketsMatching(filepath)
    } else if (!bucketNameSlash) {
      // ls /s3/myBuck*
      const buckets = await this.listBucketsMatching(filepath)
      return flatten(
        await Promise.all(buckets.map(bucketEntry => this.listObjectsMatching(bucketEntry.name, prefix, pattern)))
      )
    } else {
      // ls /s3/myBucket/myObj*
      return this.listObjectsMatching(bucketName, prefix, pattern)
    }
  }

  /** Enumerate objects with a suffix wildcard, e.g. C* */
  private async listObjectsMatching(
    bucketName: string,
    prefix: string,
    pattern: string,
    displayFullPath = false
  ): Promise<DirEntry[]> {
    try {
      const objectStream = await this.client.listObjects(bucketName, prefix)

      return new Promise((resolve, reject) => {
        const objects: DirEntry[] = []

        objectStream.on('end', () => resolve(objects))
        objectStream.on('close', () => resolve(objects))

        objectStream.on('error', err => {
          console.error('Error in S3Vfs.listObjects', err)
          const error: CodedError = new Error(err.message || 'Error listing s3 objects')
          error.code = err['httpstatuscode'] || err['code'] // missing types in @types/minio
          reject(error)
        })

        objectStream.on('data', ({ name, size, lastModified }) => {
          if ((!pattern && name === prefix) || (pattern && micromatch.isMatch(name, prefix + pattern))) {
            const path = join(this.mountPath, bucketName, name)

            objects.push({
              name,
              path,
              stats: {
                size,
                mtimeMs: lastModified.getTime(),
                mode: 0,
                uid,
                gid
              },
              nameForDisplay: displayFullPath ? path : name,
              dirent: {
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                isSpecial: false,
                isExecutable: false,
                permissions: '',
                username
              }
            })
          }
        })
      })
    } catch (err) {
      throw new Error(err.message)
    }
  }

  /** Enumerate the objects specified by the given filepath */
  private async dirstat(filepath: string, dashD: boolean): Promise<DirEntry[]> {
    try {
      if (filepath.length === 0) {
        return this.listBuckets().catch(err => {
          console.error(err)
          throw new Error(err.message)
        })
      } else {
        const start = Date.now()
        const res = await this.listObjects(filepath, dashD)
        const end = Date.now()
        debug('dirstat latency', end - start)
        return res
      }
    } catch (err) {
      console.error('Error in S3VFS.ls', err)
      return []
    }
  }

  public split(filepath: string): { bucketName: string; fileName: string } {
    const [, bucketName, fileName] = filepath.replace(this.s3Prefix, '').match(/([^/]+)\/?(.*)\*?/)
    return { bucketName, fileName }
  }

  /**
   * Upload one or more object. We consult the `vfs ls` API to
   * enumerate the source files. If parsedOptions.P is provided, we
   * set the uploaded objects to public.
   *
   */
  private async fPutObject(
    { REPL, parsedOptions }: Pick<Arguments, 'REPL' | 'parsedOptions'>,
    srcFilepaths: string[],
    dstFilepath: string
  ) {
    const sources = REPL.rexec<GlobStats[]>(`vfs ls ${srcFilepaths.map(_ => encodeComponent(_)).join(' ')}`)
    const { bucketName, fileName } = this.split(dstFilepath)

    // make public?
    const metadata = parsedOptions.P
      ? {
          'x-amz-acl': 'public-read'
        }
      : {}

    const etagsP = Promise.all(
      (await sources).content.map(_ => {
        return this.client.fPutObject(bucketName, fileName || basename(_.path), _.path, metadata)
      })
    )

    const etags = await etagsP

    if (parsedOptions.P) {
      const endPoint = /^http/.test(this.options.endPoint) ? this.options.endPoint : `https://${this.options.endPoint}`
      const srcs = (await sources).content
      if (etags.length === 1) {
        return strings('Published object as', `${endPoint}/${bucketName}/${basename(srcs[0].path)}`)
      } else if (srcs.find(_ => /index.html$/.test(_.path))) {
        return strings('Published object as', `${endPoint}/${bucketName}/index.html`)
      } else {
        return strings('Published N objects to', etags.length, `${endPoint}/${bucketName}`)
      }
    } else if (etags.length === 1) {
      return strings('Created object with etag', etags[0])
    } else {
      return strings('Created objects with etags', etags.join(', '))
    }
  }

  private async fGetObject(
    { REPL }: Pick<Arguments, 'REPL' | 'parsedOptions'>,
    srcFilepaths: string[],
    dstFilepath: string
  ) {
    const sources = REPL.rexec<GlobStats[]>(`vfs ls ${srcFilepaths.map(_ => encodeComponent(_)).join(' ')}`)

    // NOTE: intentionally not lstat; we want what is referenced by
    // the symlink
    const { stat } = await import('fs')

    const dstIsDirectory = await new Promise<boolean>((resolve, reject) => {
      stat(dstFilepath, (err, stats) => {
        if (err) {
          if (err.code === 'ENOENT') {
            // copying to new file
            resolve(false)
          } else {
            // some other error
            reject(err)
          }
        } else {
          resolve(stats.isDirectory())
        }
      })
    })

    if (!dstIsDirectory && srcFilepaths.length > 1) {
      throw new Error('Destination is not a directory')
    }

    const fetched = await Promise.all(
      (await sources).content
        .map(_ => _.path)
        .map(async srcFilepath => {
          const { bucketName, fileName } = this.split(srcFilepath)
          const dst = dstIsDirectory ? join(dstFilepath, fileName) : dstFilepath

          await this.client.fGetObject(bucketName, fileName, dst)
          return basename(srcFilepath)
        })
    )

    const N = fetched.length
    return `Fetched ${fetched.slice(0, N - 2).join(', ')}${N <= 2 ? '' : ', '}${fetched
      .slice(N - 2)
      .join(N === 2 ? ' and ' : ', and ')} to ${dstFilepath}`
  }

  private async intraCopyObject(
    args: Pick<Arguments, 'REPL' | 'parsedOptions' | 'execOptions'>,
    srcFilepaths: string[],
    dstFilepath: string
  ) {
    const sources = args.REPL.rexec<GlobStats[]>(`vfs ls ${srcFilepaths.map(_ => encodeComponent(_)).join(' ')}`)

    if (args.parsedOptions.s) {
      const srcs = (await sources).content
      debug('scale-out intra-copy-object sources', srcs)
      return runWithProgress(
        srcs.map(src => `cp ${encodeComponent(src.path)} ${encodeComponent(dstFilepath)}`),
        args
      )
    }

    const etags = await Promise.all(
      (await sources).content
        .map(_ => _.path)
        .map(async srcFilepath => {
          const { bucketName: srcBucket, fileName: srcFile } = this.split(srcFilepath)
          const { bucketName: dstBucket, fileName: dstFile } = this.split(dstFilepath)
          debug('intra-client copy src', srcFilepath, srcBucket, srcFile)
          debug('intra-client copy dst', dstFilepath, dstBucket, dstFile)

          const { etag } = await this.client.copyObject(
            dstBucket,
            dstFile || srcFile,
            `/${srcBucket}/${srcFile}`,
            new CopyConditions()
          )
          return etag
        })
    )

    const N = etags.length
    return N === 0
      ? 'Source files not found'
      : `Copied to ${N === 1 ? 'object' : 'objects'} with ${N === 1 ? 'etag' : 'etags'} ${etags.join(', ')}`
  }

  private async interCopyObject(
    args: Pick<Arguments, 'REPL' | 'parsedOptions' | 'execOptions'>,
    srcs: { srcFilepath: string; provider: S3VFSResponder }[],
    dstFilepath: string
  ) {
    const sources = args.REPL.rexec<GlobStats[]>(
      `vfs ls ${srcs
        .map(_ => _.srcFilepath)
        .map(_ => encodeComponent(_))
        .join(' ')}`
    )

    if ((await sources).content.length === 0) {
      throw new Error('Nothing to copy')
    }

    if (args.parsedOptions.s) {
      const srcs = (await sources).content
      debug('scale-out inter-copy-object sources', srcs)
      return runWithProgress(
        srcs.map(src => `cp ${encodeComponent(src.path)} ${encodeComponent(dstFilepath)}`),
        args
      )
    }

    debug('inter-copy-object sources', (await sources).content)
    const etags = await Promise.all(
      (await sources).content
        .map(_ => _.path)
        .map(async (srcFilepath, idx) => {
          const { provider: srcProvider } = srcs[idx]
          const { bucketName: srcBucket, fileName: srcFile } = srcProvider.split(srcFilepath)
          const { bucketName: dstBucket, fileName: dstFile } = this.split(dstFilepath)
          debug('inter-client copy src', srcFilepath, srcBucket, srcFile)
          debug('inter-client copy dst', dstFilepath, dstBucket, dstFile)

          const stream = await srcProvider.client.getObject(srcBucket, srcFile)
          const etag = await this.client.putObject(dstBucket, dstFile || srcFile, stream)
          return etag
        })
    )

    const N = etags.length
    return N === 0
      ? 'Source files not found'
      : `Copied to ${N === 1 ? 'object' : 'objects'} with ${N === 1 ? 'etag' : 'etags'} ${etags.join(', ')}`
  }

  /** Insert filepath into directory */
  public async cp(
    args: Pick<Arguments, 'command' | 'REPL' | 'parsedOptions' | 'execOptions'>,
    srcFilepaths: string[],
    dstFilepath: string,
    srcIsSelf: boolean[],
    dstIsSelf: boolean,
    srcProvider: VFS[]
    /* , dstProvider: VFS */
  ) {
    try {
      const selfSrc = srcFilepaths.filter((_, idx) => srcIsSelf[idx])
      const otherNonS3Src = srcFilepaths.filter((_, idx) => !srcIsSelf[idx] && !isS3Provider(srcProvider[idx]))
      const otherS3Src = srcFilepaths
        .map((srcFilepath, idx) => {
          const provider = srcProvider[idx]
          if (!srcIsSelf[idx] && isS3Provider(provider)) {
            return { srcFilepath, provider }
          }
        })
        .filter(_ => _)

      if (dstIsSelf) {
        // copying into or between s3 buckets
        const copyInTasks = otherNonS3Src.length === 0 ? [] : [this.fPutObject(args, otherNonS3Src, dstFilepath)]
        const intraClientCopyTasks = selfSrc.length === 0 ? [] : [this.intraCopyObject(args, selfSrc, dstFilepath)]
        const interClientCopyTasks =
          otherS3Src.length === 0 ? [] : [this.interCopyObject(args, otherS3Src, dstFilepath)]

        return await Promise.all([...copyInTasks, ...intraClientCopyTasks, ...interClientCopyTasks])
      } else {
        // copying out of an s3 bucket
        return this.fGetObject(args, srcFilepaths, dstFilepath)
      }
    } catch (err) {
      const error: CodedError = new Error(err.message)
      error.code = err['httpstatuscode'] || err['code'] // missing types in @types/minio
      throw error
    }
  }

  /** @return recursive list of objects in `bucketName` */
  private async objectsIn(bucketName: string) {
    try {
      const stream = await this.client.listObjects(bucketName, undefined, true)

      return new Promise<string[]>((resolve, reject) => {
        const objects: string[] = []
        stream.on('error', reject)
        stream.on('end', () => resolve(objects))
        stream.on('data', ({ name }) => objects.push(name))
      })
    } catch (err) {
      const error: CodedError = new Error(err.message)
      error.code = err['httpstatuscode'] || err['code'] // missing types in @types/minio
      throw error
    }
  }

  /** rm -rf */
  private async rimraf(bucketName: string): Promise<string> {
    const buckets = await this.listBucketsMatching(bucketName)
    await Promise.all(
      buckets.map(async ({ name: bucketName }) => {
        await this.client.removeObjects(bucketName, await this.objectsIn(bucketName))
        await this.client.removeBucket(bucketName)
      })
    )

    return strings(buckets.length === 1 ? 'Removed bucket X and its contents' : 'Removed N buckets and their contents')
  }

  /** Remove filepath */
  public async rm(_, filepath: string, recursive = false): ReturnType<VFS['rm']> {
    try {
      const { bucketName, fileName } = this.split(filepath)
      if (!fileName) {
        if (!recursive) {
          throw new Error(`rm: ${bucketName} is a bucket`)
        } else {
          return this.rimraf(bucketName)
        }
      } else {
        const objects = await this.listObjects(filepath.replace(this.s3Prefix, ''))
        await this.client.removeObjects(
          bucketName,
          objects.map(_ => _.name)
        )
        return true
      }
    } catch (err) {
      throw new Error(err.message)
    }
  }

  /** Fetch contents */
  public fstat(_, filepath: string): Promise<FStat> {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      try {
        const { bucketName, fileName } = this.split(filepath)

        const stream = await this.client.getObject(bucketName, fileName)
        let data = ''
        stream.on('error', reject)
        stream.on('data', chunk => (data += chunk))

        stream.on('end', () => {
          resolve({
            viewer: 'open',
            filepath,
            fullpath: filepath,
            isDirectory: false,
            data
          })
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  /** Create a directory/bucket */
  public async mkdir(_, filepath: string): Promise<void> {
    const { bucketName } = this.split(filepath)

    try {
      await this.client.makeBucket(bucketName, '') // '': use default region
    } catch (err) {
      // for some reason, the core repl does not like minio's error
      if (/Invalid bucket name/.test(err.message)) {
        if (bucketName.length <= 2) {
          throw new Error(err.message + `. Bucket names must have at least 3 characters.`)
        } else if (bucketName.length > 63) {
          throw new Error(err.message + `. Bucket names must have no more than 63 characters.`)
        } else if (/_/.test(bucketName)) {
          throw new Error(err.message + `. Bucket names must not contain underscore.`)
        } else if (/-$/.test(bucketName)) {
          throw new Error(err.message + `. Bucket names must not end with a dash.`)
        } else if (/\./.test(bucketName)) {
          throw new Error(err.message + `. Bucket names must not contain dots.`)
        }
      }
      throw new Error(err.message)
    }
  }

  /** Remove a directory/bucket */
  public async rmdir(_, filepath: string): Promise<void> {
    const { bucketName } = this.split(filepath)

    try {
      await this.client.removeBucket(bucketName)
    } catch (err) {
      throw new Error(err.message)
    }
  }

  private async getLogsForTask(jobProvider: JobProvider, jobname: string, taskIdx: number): Promise<string[]> {
    const logs = await jobProvider.logs(jobname, taskIdx)
    const logLines = logs.split(/\n/).filter(_ => /^GREP /.test(_))

    return logLines.map(_ => _.replace(/^GREP /, ''))
  }

  private async getLogs(jobProvider: JobProvider, jobname: string, nTasks: number): Promise<string[]> {
    return flatten(
      await Promise.all(
        Array(nTasks)
          .fill(0)
          .map((_, idx) => this.getLogsForTask(jobProvider, jobname, idx + 1))
      )
    )
  }

  /**
   * Generic doPar of the given `operation` done in data-parallel
   * fashion across the given `filepaths`. You may optionally overlay
   * extra `env` variables onto the task executions.
   *
   */
  private async doPar<NeedsLogs extends boolean = false>(
    opts: Arguments<ParallelismOptions>,
    operation: ParallelOperation,
    filepaths: string[],
    needsLogs: NeedsLogs,
    env: JobEnv = {},
    nTasks = opts.parsedOptions.P || 20,
    nShards = nTasks
  ) {
    const jobProvider = this.runner(opts.REPL)

    const perFileResults = await Promise.all(
      filepaths.map(async filepath => {
        const { bucketName, fileName } = this.split(filepath)
        const jobname = await jobProvider.run(
          'starpit/vfs',
          {
            nTasks,
            nShards: nShards || nTasks,
            OPERATION: operation,
            SRC_BUCKET: bucketName,
            SRC_OBJECT: fileName
          },
          env
        )

        await jobProvider.wait(jobname, nTasks)

        if (needsLogs) {
          return this.getLogs(jobProvider, jobname, nTasks)
        }
      })
    )

    return perFileResults
  }

  public async grep(
    opts: Parameters<VFS['grep']>[0],
    pattern: string,
    filepaths: string[]
  ): Promise<number | string[]> {
    const srcs = (await opts.REPL.rexec<GlobStats[]>(`vfs ls ${filepaths.map(_ => encodeComponent(_)).join(' ')}`))
      .content
    const perFileResults = await runWithLogs(
      srcs.map(_ => `cat ${encodeComponent(_.path)} | grep ${encodeComponent(pattern)}`),
      opts
    )

    if (opts.parsedOptions.c) {
      // user asked for a count; so we need a reduction post-processing pass
      return perFileResults.map(_ => _.split(/\n/).filter(_ => _).length).reduce((sum, count) => sum + count, 0)
    } else if (opts.parsedOptions.l) {
      // user asked for a list of matching files; so again we need to post-process
      return perFileResults.reduce((matchingFiles, matches, idx) => {
        if (matches.length > 0) {
          matchingFiles.push(filepaths[idx])
        }
        return matchingFiles
      }, [])
    } else {
      // otherwise, return the list of matches
      if (perFileResults.every(_ => _.length === 0)) {
        throw new Error('')
      } else {
        return perFileResults
      }
    }
  }

  /** zip a set of files */
  public async gzip(...parameters: Parameters<VFS['gzip']>): ReturnType<VFS['gzip']> {
    const { REPL, parsedOptions } = parameters[0]
    const srcFilepaths = parameters[1]
    const srcs = (await REPL.rexec<GlobStats[]>(`vfs ls ${srcFilepaths.map(_ => encodeComponent(_)).join(' ')}`))
      .content

    if (!parsedOptions.memory) {
      parsedOptions.memory = '1024Mi'
    }
    if (!parsedOptions.cpu) {
      parsedOptions.cpu = 8
    }

    debug('scale-out gzip sources', srcs, parsedOptions)
    return runWithProgress(
      srcs.map(src => `cat ${encodeComponent(src.path)} | gzip -c - | pipe ${encodeComponent(src.path + '.gz')}`),
      parameters[0],
      parsedOptions
    )
  }

  /** unzip a set of files */
  public async gunzip(...parameters: Parameters<VFS['gunzip']>): ReturnType<VFS['gunzip']> {
    const { REPL, parsedOptions } = parameters[0]
    const srcFilepaths = parameters[1]
    const srcs = (await REPL.rexec<GlobStats[]>(`vfs ls ${srcFilepaths.map(_ => encodeComponent(_)).join(' ')}`))
      .content

    if (!parsedOptions.memory) {
      parsedOptions.memory = '1024Mi'
    }
    if (!parsedOptions.cpu) {
      parsedOptions.cpu = 8
    }

    debug('scale-out gunzip sources', srcs, parsedOptions)
    return runWithProgress(
      srcs.map(
        src => `cat ${encodeComponent(src.path)} | gunzip -c - | pipe ${encodeComponent(src.path.replace(/.gz$/, ''))}`
      ),
      parameters[0],
      parsedOptions
    )
  }

  private runner(repl: REPL) {
    return new CodeEngine(repl, this.options)
  }
}

export default async () => {
  const init = () => {
    mount(async (repl: REPL) => {
      try {
        const providers = await findAvailableProviders(repl, init)
        debug(
          'available s3 providers',
          providers.map(_ => _.mountName)
        )

        return setResponders(
          providers,
          providers.map(provider => new S3VFSResponder(provider))
        )
      } catch (err) {
        console.error('Error initializing s3 vfs', err)
      }
    })
  }

  init()
}
