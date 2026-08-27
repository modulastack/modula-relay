// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import net from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as schedule } from 'node:timers'
import { ensureRelaySocketDirectory } from './relayEndpoint.js'

export const lineCap = 64 * 1024
const connectTimeoutMs = 1_000
// Ack reads tolerate a peer busy mid-turn: a 1s window produced spurious timeouts and duplicate re-sends.
const ackTimeoutMs = 3_000

export class EndpointUnreachableError extends Error {}

export function connect(endpoint: string) {
  ensureRelaySocketDirectory(endpoint)
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint })
    const timer = setTimeout(() => { socket.destroy(); reject(new EndpointUnreachableError('connection timed out')) }, connectTimeoutMs)
    const fail = (error: Error) => {
      clearTimeout(timer)
      socket.destroy()
      // Only endpoint absence proves the peer is gone; local transient errors (EMFILE, EACCES…) propagate unchanged
      const code = (error as NodeJS.ErrnoException).code
      reject(code === 'ENOENT' || code === 'ECONNREFUSED' ? new EndpointUnreachableError(error.message) : error)
    }
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', fail)
  })
}

export async function withTimeout<T>(promise: Promise<T>, waitMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return undefined
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([promise, new Promise<undefined>(resolve => {
      timer = schedule(() => resolve(undefined), waitMs)
      timer.unref()
      if (signal) { onAbort = () => resolve(undefined); signal.addEventListener('abort', onAbort, { once: true }) }
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

// A failed read detaches its listeners: rejection alone would leave the data listener
// appending to the buffer forever — the exact unbounded growth the cap exists to stop.
// A cap breach settles WITHOUT destroying, so the server can still answer with a nack
// (the documented reject); a deadline or transport error destroys outright.
export function readLine(socket: net.Socket, waitMs = ackTimeoutMs) {
  return new Promise<string>((resolve, reject) => {
    // Byte-counted cap (the wire bound is encoded size) and a stateful decoder so a
    // multibyte character split across chunks decodes intact instead of corrupting.
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let bytes = 0
    // After settling, the socket keeps an error absorber: the server still writes its
    // reply on this socket, and a peer resetting in that window would otherwise raise an
    // unhandled 'error' event and kill the whole process.
    const settle = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', failHard); socket.off('close', onClose); socket.on('error', () => socket.destroy()) }
    const failSoft = (error: Error) => { settle(); reject(error) }
    const failHard = (error: Error) => { settle(); socket.destroy(); reject(error) }
    const onClose = () => failHard(new Error('connection closed before line received'))
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > lineCap) return failSoft(new Error('line too large'))
      buffer += decoder.write(chunk)
      const index = buffer.indexOf('\n')
      if (index >= 0) { settle(); resolve(buffer.slice(0, index)) }
    }
    const timer = setTimeout(() => failHard(new Error('response timed out')), waitMs)
    socket.on('data', onData)
    socket.once('error', failHard)
    socket.once('close', onClose)
  })
}
