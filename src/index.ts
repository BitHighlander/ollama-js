import * as utils from './utils.js'
import { AbortableAsyncIterator } from './utils.js'

import fs, { createReadStream, promises } from 'fs'
import { dirname, join, resolve } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { Ollama as OllamaBrowser } from './browser.js'

import type { CreateRequest, ProgressResponse } from './interfaces.js'

export class Ollama extends OllamaBrowser {
  async encodeImage(image: Uint8Array | Buffer | string): Promise<string> {
    if (typeof image !== 'string') {
      return Buffer.from(image).toString('base64')
    }
    try {
      if (fs.existsSync(image)) {
        const fileBuffer = await promises.readFile(resolve(image))
        return Buffer.from(fileBuffer).toString('base64')
      }
    } catch {
      // continue
    }
    return image
  }

  private async parseModelfile(
      modelfile: string,
      mfDir: string = process.cwd(),
  ): Promise<string> {
    const out: string[] = []
    const lines = modelfile.split('\n')
    for (const line of lines) {
      const [command, args] = line.split(' ', 2)
      if (['FROM', 'ADAPTER'].includes(command.toUpperCase())) {
        const path = this.resolvePath(args.trim(), mfDir)
        if (await this.fileExists(path)) {
          out.push(`${command} @${await this.createBlob(path)}`)
        } else {
          out.push(`${command} ${args}`)
        }
      } else {
        out.push(line)
      }
    }
    return out.join('\n')
  }

  private resolvePath(inputPath, mfDir) {
    if (inputPath.startsWith('~')) {
      return join(homedir(), inputPath.slice(1))
    }
    return resolve(mfDir, inputPath)
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await promises.access(path)
      return true
    } catch {
      return false
    }
  }

  private async createBlob(path: string): Promise<string> {
    if (typeof ReadableStream === 'undefined') {
      throw new Error('Streaming uploads are not supported in this environment.')
    }

    const fileStream = createReadStream(path)

    const sha256sum = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256')
      fileStream.on('data', (data) => hash.update(data))
      fileStream.on('end', () => resolve(hash.digest('hex')))
      fileStream.on('error', reject)
    })

    const digest = `sha256:${sha256sum}`

    try {
      await utils.head(this.fetch, `${this.config.host}/api/blobs/${digest}`, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      })
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) {
        const readableStream = new ReadableStream({
          start(controller) {
            fileStream.on('data', (chunk) => {
              controller.enqueue(chunk)
            })

            fileStream.on('end', () => {
              controller.close()
            })

            fileStream.on('error', (err) => {
              controller.error(err)
            })
          },
        })

        await utils.post(
            this.fetch,
            `${this.config.host}/api/blobs/${digest}`,
            readableStream,
            {
              headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/octet-stream',  // Assuming it's an octet-stream for binary data
              }
            }
        )
      } else {
        throw e
      }
    }

    return digest
  }

  create(
      request: CreateRequest & { stream: true },
  ): Promise<AbortableAsyncIterator<ProgressResponse>>
  create(request: CreateRequest & { stream?: false }): Promise<ProgressResponse>

  async create(
      request: CreateRequest,
  ): Promise<ProgressResponse | AbortableAsyncIterator<ProgressResponse>> {
    let modelfileContent = ''
    if (request.path) {
      modelfileContent = await promises.readFile(request.path, { encoding: 'utf8' })
      modelfileContent = await this.parseModelfile(
          modelfileContent,
          dirname(request.path),
      )
    } else if (request.modelfile) {
      modelfileContent = await this.parseModelfile(request.modelfile)
    } else {
      throw new Error('Must provide either path or modelfile to create a model')
    }
    request.modelfile = modelfileContent

    if (request.stream) {
      return super.create(request as CreateRequest & { stream: true })
    } else {
      return super.create(request as CreateRequest & { stream: false })
    }
  }
}

export default new Ollama()

export * from './interfaces.js'
