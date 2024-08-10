import { version } from './version.js'
import type { ErrorResponse, Fetch } from './interfaces.js'

class ResponseError extends Error {
  constructor(
      public error: string,
      public status_code: number,
  ) {
    super(error)
    this.name = 'ResponseError'

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ResponseError)
    }
  }
}

export class AbortableAsyncIterator<T extends object> {
  private readonly abortController: AbortController
  private readonly itr: AsyncGenerator<T | ErrorResponse>
  private readonly doneCallback: () => void

  constructor(abortController: AbortController, itr: AsyncGenerator<T | ErrorResponse>, doneCallback: () => void) {
    this.abortController = abortController
    this.itr = itr
    this.doneCallback = doneCallback
  }

  abort() {
    this.abortController.abort()
  }

  async *[Symbol.asyncIterator]() {
    for await (const message of this.itr) {
      if ('error' in message) {
        throw new Error(message.error)
      }
      yield message
      if ((message as any).done || (message as any).status === 'success') {
        this.doneCallback()
        return
      }
    }
    throw new Error('Did not receive done or success response in stream.')
  }
}

const checkOk = async (response: Response): Promise<void> => {
  if (response.ok) {
    return
  }
  let message = `Error ${response.status}: ${response.statusText}`
  let errorData: ErrorResponse | null = null

  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      errorData = (await response.json()) as ErrorResponse
      message = errorData.error || message
    } catch (error) {
      console.log('Failed to parse error response as JSON')
    }
  } else {
    try {
      console.log('Getting text from response')
      const textResponse = await response.text()
      message = textResponse || message
    } catch (error) {
      console.log('Failed to get text from error response')
    }
  }

  throw new ResponseError(message, response.status)
}

function getPlatform(): string {
  if (typeof window !== 'undefined' && window.navigator) {
    return `${window.navigator.platform.toLowerCase()} Browser/${navigator.userAgent};`
  } else if (typeof process !== 'undefined') {
    return `${process.arch} ${process.platform} Node.js/${process.version}`
  }
  return ''
}

const fetchWithHeaders = async (
    fetch: Fetch,
    url: string,
    options: any,
): Promise<Response> => {
  const defaultHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `ollama-js/${version} (${getPlatform()})`,
  }

  if (!options.headers) {
    options.headers = {}
  }

  options.headers = {
    ...defaultHeaders,
    ...options.headers,
  }
  console.log('url:', url)
  console.log('options:', options)
  return fetch(url, options)
}

export const get = async (
    fetch: Fetch,
    host: string,
    headers?: Record<string, string>
): Promise<Response> => {
  const response = await fetchWithHeaders(fetch, host, {
    headers,
  })

  await checkOk(response)

  return response
}

export const head = async (
    fetch: Fetch,
    host: string,
    headers?: { headers: { Authorization: string } }
): Promise<Response> => {
  const response = await fetchWithHeaders(fetch, host, {
    method: 'HEAD',
    headers,
  })

  await checkOk(response)

  return response
}

export const post = async (
    fetch: Fetch,
    host: string,
    data?: Record<string, unknown> | BodyInit,
    options?: { signal?: AbortSignal, headers?: Record<string, string> },
): Promise<Response> => {
  const isRecord = (input: any): input is Record<string, unknown> => {
    return input !== null && typeof input === 'object' && !Array.isArray(input)
  }

  const formattedData = isRecord(data) ? JSON.stringify(data) : data

  const response = await fetchWithHeaders(fetch, host, {
    method: 'POST',
    body: formattedData,
    signal: options?.signal,
    headers: options?.headers,
  })

  await checkOk(response)

  return response
}

export const del = async (
    fetch: Fetch,
    host: string,
    data?: Record<string, unknown>,
    headers?: Record<string, string>
): Promise<Response> => {
  const response = await fetchWithHeaders(fetch, host, {
    method: 'DELETE',
    body: JSON.stringify(data),
    headers,
  })

  await checkOk(response)

  return response
}

export const parseJSON = async function* <T = unknown>(
    itr: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const reader = itr.getReader()

  while (true) {
    const { done, value: chunk } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(chunk)

    const parts = buffer.split('\n')

    buffer = parts.pop() ?? ''

    for (const part of parts) {
      try {
        yield JSON.parse(part)
      } catch (error) {
        console.warn('invalid json: ', part)
      }
    }
  }

  for (const part of buffer.split('\n').filter((p) => p !== '')) {
    try {
      yield JSON.parse(part)
    } catch (error) {
      console.warn('invalid json: ', part)
    }
  }
}

export const formatHost = (host: string): string => {
  if (!host) {
    return 'http://127.0.0.1:1646'
  }

  let isExplicitProtocol = host.includes('://')

  if (host.startsWith(':')) {
    host = `http://127.0.0.1${host}`
    isExplicitProtocol = true
  }

  if (!isExplicitProtocol) {
    host = `http://${host}`
  }

  const url = new URL(host)

  let port = url.port
  if (!port) {
    if (!isExplicitProtocol) {
      port = '11434'
    } else {
      port = url.protocol === 'https:' ? '443' : '80'
    }
  }

  let formattedHost = `${url.protocol}//${url.hostname}:${port}${url.pathname}`
  if (formattedHost.endsWith('/')) {
    formattedHost = formattedHost.slice(0, -1)
  }

  return formattedHost
}
