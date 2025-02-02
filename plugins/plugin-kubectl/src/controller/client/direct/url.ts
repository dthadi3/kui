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

import { Arguments } from '@kui-shell/core'

import { Explained } from '../../kubectl/explain'
import { KubeOptions, getLabel, getNamespace, isForAllNamespaces } from '../../kubectl/options'

export type URLFormatter = (includeKind?: boolean, includeQueries?: boolean, name?: string) => string

export function urlFormatterFor(
  namespace: string,
  { parsedOptions }: Pick<Arguments<KubeOptions>, 'parsedOptions'>,
  { kind, version, isClusterScoped }: Explained
): URLFormatter {
  const kindOnPath = `/${encodeURIComponent(kind.toLowerCase() + (/s$/.test(kind) ? '' : 's'))}`

  // e.g. "apis/apps/v1" for deployments
  const apiOnPath = version === 'v1' ? 'api/v1' : `apis/${encodeURIComponent(version)}`

  // a bit complex: "kubectl get ns", versus "kubectl get ns foo"
  // the "which" is "foo" in the second case
  const namespaceOnPath = isForAllNamespaces(parsedOptions)
    ? ''
    : kind === 'Namespace'
    ? ''
    : isClusterScoped
    ? ''
    : `/namespaces/${encodeURIComponent(namespace)}`

  // we will accumulate queries
  const queries: string[] = []

  // labelSelector query
  const label = getLabel({ parsedOptions })
  if (label) {
    const push = (query: string) => queries.push(`labelSelector=${encodeURIComponent(query)}`)
    if (Array.isArray(label)) {
      label.forEach(push)
    } else {
      push(label)
    }
  }

  // fieldSelector query; chained selectors are comma-separated
  if (parsedOptions['field-selector'] && typeof parsedOptions['field-selector'] === 'string') {
    queries.push(`fieldSelector=${encodeURIComponent(parsedOptions['field-selector'])}`)
  }

  // limit query
  if (typeof parsedOptions.limit === 'number') {
    queries.push(`limit=${parsedOptions.limit}`)
  }

  // format a url
  return (includeKind = false, includeQueries = false, name?: string) =>
    `kubernetes:///${apiOnPath}${namespaceOnPath}${!includeKind ? '' : kindOnPath}${
      !name ? '' : `/${encodeURIComponent(name)}`
    }${!includeQueries || queries.length === 0 ? '' : '?' + queries.join('&')}`
}

export async function urlFormatterForArgs(
  args: Arguments<KubeOptions>,
  explainedKind: Explained
): Promise<URLFormatter> {
  return urlFormatterFor(await getNamespace(args), args, explainedKind)
}

export default URLFormatter
