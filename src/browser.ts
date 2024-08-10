import * as utils from './utils.js'
import { AbortableAsyncIterator, parseJSON, post } from './utils.js'

import type {
  ChatRequest,
  ChatResponse,
  Config,
  CopyRequest,
  CreateRequest,
  DeleteRequest,
  EmbedRequest,
  EmbedResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ErrorResponse,
  Fetch,
  GenerateRequest,
  GenerateResponse,
  ListResponse,
  ProgressResponse,
  PullRequest,
  PushRequest,
  ShowRequest,
  ShowResponse,
  StatusResponse,
} from './interfaces.js'

export class Ollama {
  protected readonly config: Config
  protected readonly fetch: Fetch
  protected readonly ongoingStreamedRequests: AbortableAsyncIterator<object>[] = []

  constructor(config?: Partial<Config>) {
    this.config = {
      host: '',
      ...config,
    }
    if (!config?.proxy) {
      this.config.host = utils.formatHost(config?.host ?? 'http://127.0.0.1:11434')
    }

    this.fetch = config?.fetch || this.getFetch();
  }

  private getFetch(): Fetch {
    if (typeof window !== 'undefined' && window.fetch) {
      return window.fetch.bind(window);
    }

    if (typeof global !== 'undefined' && global.fetch) {
      return global.fetch;
    }

    try {
      return require('node-fetch');
    } catch (error) {
      console.error('Failed to import node-fetch:', error);
      throw new Error('Fetch is not available. Please provide a fetch implementation in the config.');
    }
  }

  public abort() {
    for (const request of this.ongoingStreamedRequests) {
      request.abort()
    }
    this.ongoingStreamedRequests.length = 0
  }

  protected async processStreamableRequest<T extends object>(
      endpoint: string,
      request: { stream?: boolean } & Record<string, any>,
  ): Promise<T | AbortableAsyncIterator<T>> {
    request.stream = request.stream ?? false
    const host = `${this.config.host}/api/${endpoint}`
    const headers = { 'Authorization': `Bearer ${this.config.apiKey}` }

    if (request.stream) {
      const abortController = new AbortController()
      const response = await post(this.fetch, host, request, {
        signal: abortController.signal,
        headers,
      })

      if (!response.body) {
        throw new Error('Missing body')
      }

      const itr = parseJSON<T | ErrorResponse>(response.body)
      const abortableAsyncIterator = new AbortableAsyncIterator(
          abortController,
          itr,
          () => {
            const i = this.ongoingStreamedRequests.indexOf(abortableAsyncIterator)
            if (i > -1) {
              this.ongoingStreamedRequests.splice(i, 1)
            }
          },
      )
      this.ongoingStreamedRequests.push(abortableAsyncIterator)
      return abortableAsyncIterator
    }
    const response = await utils.post(this.fetch, host, request, { headers })
    return await response.json()
  }

  async encodeImage(image: Uint8Array | string): Promise<string> {
    if (typeof image !== 'string') {
      const uint8Array = new Uint8Array(image);
      let byteString = '';
      const len = uint8Array.byteLength;
      for (let i = 0; i < len; i++) {
        byteString += String.fromCharCode(uint8Array[i]);
      }
      return btoa(byteString);
    }
    return image;
  }

  generate(
      request: GenerateRequest & { stream: true },
  ): Promise<AbortableAsyncIterator<GenerateResponse>>
  generate(request: GenerateRequest & { stream?: false }): Promise<GenerateResponse>

  async generate(
      request: GenerateRequest,
  ): Promise<GenerateResponse | AbortableAsyncIterator<GenerateResponse>> {
    if (request.images) {
      request.images = await Promise.all(request.images.map(this.encodeImage.bind(this)))
    }
    return this.processStreamableRequest<GenerateResponse>('generate', request)
  }

  chat(
      request: ChatRequest & { stream: true },
  ): Promise<AbortableAsyncIterator<ChatResponse>>
  chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>

  async chat(
      request: ChatRequest,
  ): Promise<ChatResponse | AbortableAsyncIterator<ChatResponse>> {
    if (request.messages) {
      for (const message of request.messages) {
        if (message.images) {
          message.images = await Promise.all(
              message.images.map(this.encodeImage.bind(this)),
          )
        }
      }
    }
    return this.processStreamableRequest<ChatResponse>('chat', request)
  }

  create(
      request: CreateRequest & { stream: true },
  ): Promise<AbortableAsyncIterator<ProgressResponse>>
  create(request: CreateRequest & { stream?: false }): Promise<ProgressResponse>

  async create(
      request: CreateRequest,
  ): Promise<ProgressResponse | AbortableAsyncIterator<ProgressResponse>> {
    return this.processStreamableRequest<ProgressResponse>('create', {
      name: request.model,
      stream: request.stream,
      modelfile: request.modelfile,
      quantize: request.quantize,
    })
  }

  pull(
      request: PullRequest & { stream: true },
  ): Promise<AbortableAsyncIterator<ProgressResponse>>
  pull(request: PullRequest & { stream?: false }): Promise<ProgressResponse>

  async pull(
      request: PullRequest,
  ): Promise<ProgressResponse | AbortableAsyncIterator<ProgressResponse>> {
    return this.processStreamableRequest<ProgressResponse>('pull', {
      name: request.model,
      stream: request.stream,
      insecure: request.insecure,
    })
  }

  push(
      request: PushRequest & { stream: true },
  ): Promise<AbortableAsyncIterator<ProgressResponse>>
  push(request: PushRequest & { stream?: false }): Promise<ProgressResponse>

  async push(
      request: PushRequest,
  ): Promise<ProgressResponse | AbortableAsyncIterator<ProgressResponse>> {
    return this.processStreamableRequest<ProgressResponse>('push', {
      name: request.model,
      stream: request.stream,
      insecure: request.insecure,
    })
  }

  async delete(request: DeleteRequest): Promise<StatusResponse> {
    await utils.del(this.fetch, `${this.config.host}/api/delete`, {
      name: request.model,
    }, { 'Authorization': `Bearer ${this.config.apiKey}` })
    return { status: 'success' }
  }

  async copy(request: CopyRequest): Promise<StatusResponse> {
    await utils.post(this.fetch, `${this.config.host}/api/copy`, { ...request }, {
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
    })
    return { status: 'success' }
  }

  async list(): Promise<ListResponse> {
    const response = await utils.get(this.fetch, `${this.config.host}/api/tags`, {
      'Authorization': `Bearer ${this.config.apiKey}`
    })
    return (await response.json()) as ListResponse
  }

  async show(request: ShowRequest): Promise<ShowResponse> {
    const response = await utils.post(this.fetch, `${this.config.host}/api/show`, {
      ...request,
    }, { headers: { 'Authorization': `Bearer ${this.config.apiKey}` } })
    return (await response.json()) as ShowResponse
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const response = await utils.post(this.fetch, `${this.config.host}/api/embed`, {
      ...request,
    }, { headers: { 'Authorization': `Bearer ${this.config.apiKey}` } })
    return (await response.json()) as EmbedResponse
  }

  async embeddings(request: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const response = await utils.post(this.fetch, `${this.config.host}/api/embeddings`, {
      ...request,
    }, { headers: { 'Authorization': `Bearer ${this.config.apiKey}` } })
    return (await response.json()) as EmbeddingsResponse
  }

  async ps(): Promise<ListResponse> {
    const response = await utils.get(this.fetch, `${this.config.host}/api/ps`, {
      'Authorization': `Bearer ${this.config.apiKey}`
    })
    return (await response.json()) as ListResponse
  }
}

export default new Ollama()

export * from './interfaces.js'
