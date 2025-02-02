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

import { Arguments, REPL, Table, encodeComponent } from '@kui-shell/core'
import { DirEntry, FStat, VFS, mount } from '@kui-shell/plugin-bash-like/fs'

import S3VFS from '../S3VFS'
import setResponders from '../responders'
import findAvailableProviders from '../../providers'

class S3VFSForwarder extends S3VFS implements VFS {
  /** Directory listing */
  public async ls(opts: Pick<Arguments, 'tab' | 'REPL' | 'parsedOptions'>, filepaths: string[]): Promise<DirEntry[]> {
    return (
      await opts.REPL.rexec<DirEntry[]>(
        `vfs-s3 ls ${this.mountPath} ${filepaths.map(_ => encodeComponent(_)).join(' ')}`
      )
    ).content
  }

  /** Insert filepath into directory */
  public cp(
    opts: Pick<Arguments, 'command' | 'REPL' | 'parsedOptions' | 'execOptions'>,
    srcFilepaths: string[],
    dstFilepath: string,
    srcIsSelf: boolean[],
    dstIsSelf: boolean,
    srcProvider: VFS[],
    dstProvider: VFS
  ): Promise<string> {
    return opts.REPL.qexec<string>(
      `vfs-s3 cp ${this.mountPath} ${srcFilepaths.map(_ => encodeComponent(_)).join(' ')} ${encodeComponent(
        dstFilepath
      )} ${srcIsSelf.join(',')} ${dstIsSelf.toString()} ${srcProvider.map(_ => _.mountPath).join(',')} ${
        dstProvider.mountPath
      }`
    )
  }

  /** Remove filepath */
  public rm(
    opts: Pick<Arguments, 'command' | 'REPL' | 'parsedOptions' | 'execOptions'>,
    filepath: string,
    recursive?: boolean
  ): ReturnType<VFS['rm']> {
    return opts.REPL.qexec(`vfs-s3 rm ${this.mountPath} ${encodeComponent(filepath)} ${!!recursive}`)
  }

  /** Fetch contents */
  public async fstat(
    opts: Pick<Arguments, 'REPL' | 'parsedOptions'>,
    filepath: string,
    withData?: boolean,
    enoentOk?: boolean
  ): Promise<FStat> {
    return (
      await opts.REPL.rexec<FStat>(
        `vfs-s3 fstat ${this.mountPath} ${encodeComponent(filepath)} ${!!withData} ${!!enoentOk}`
      )
    ).content
  }

  /** Create a directory/bucket */
  public async mkdir(
    opts: Pick<Arguments, 'command' | 'REPL' | 'parsedOptions' | 'execOptions'>,
    filepath: string
  ): Promise<void> {
    await opts.REPL.qexec(`vfs-s3 mkdir ${this.mountPath} ${encodeComponent(filepath)}`)
  }

  /** remove a directory/bucket */
  public async rmdir(
    opts: Pick<Arguments, 'command' | 'REPL' | 'parsedOptions' | 'execOptions'>,
    filepath: string
  ): Promise<void> {
    await opts.REPL.qexec(`vfs-s3 rmdir ${this.mountPath} ${encodeComponent(filepath)}`)
  }

  public async grep(opts: Arguments, pattern: string, filepaths: string[]): Promise<string[]> {
    return opts.REPL.qexec(
      `vfs-s3 grep ${this.mountPath} ${encodeComponent(pattern)} ${filepaths.map(_ => encodeComponent(_)).join(' ')}`
    )
  }

  /** zip a set of files */
  public gzip(...parameters: Parameters<VFS['gzip']>): ReturnType<VFS['gzip']> {
    return parameters[0].REPL.qexec<Table>(
      `vfs-s3 gzip ${this.mountPath} ${parameters[1].map(_ => encodeComponent(_)).join(' ')}`
    )
  }

  /** unzip a set of files */
  public gunzip(...parameters: Parameters<VFS['gunzip']>): ReturnType<VFS['gunzip']> {
    return parameters[0].REPL.qexec<Table>(
      `vfs-s3 gunzip ${this.mountPath} ${parameters[1].map(_ => encodeComponent(_)).join(' ')}`
    )
  }
}

export default async () => {
  const init = () => {
    mount(async (repl: REPL) => {
      try {
        const providers = await findAvailableProviders(repl, init)
        return setResponders(
          providers,
          providers.map(provider => new S3VFSForwarder(provider.mountName))
        )
      } catch (err) {
        console.error('Error initializing s3 vfs', err)
      }
    })
  }

  init()
}
