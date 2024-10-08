// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export interface Digester {
  update: (bytes: ArrayBuffer | ArrayBufferView) => Promise<void>

  digest: () => Promise<ArrayBuffer | undefined>
}

export function noopDigester(): Digester {
  return {
    // @ts-expect-error-next-line
    async update(_bytes: Uint8Array): Promise<void> {
      return Promise.resolve()
    },
    // @ts-expect-error-next-line
    async digest(): Promise<Uint8Array | undefined> {
      return undefined
    },
  }
}

export function sha256Digester(): Digester {
  // @ts-expect-error-next-line
  const stream = new crypto.DigestStream('SHA-256')
  const writer = stream.getWriter()
  return {
    async update(bytes: ArrayBuffer | ArrayBufferView): Promise<void> {
      return await writer.write(bytes)
    },
    async digest(): Promise<ArrayBuffer | undefined> {
      await writer.close()
      return await stream.digest
    },
  }
}
