/**
 * Mail port (contract §12.2). The driver receives a template id + structured variables, never
 * arbitrary client HTML. Tests use an in-memory sink; SMTP is not part of the portable v1.
 */
export interface MailMessage {
  readonly to: string
  readonly templateId: string
  readonly variables: Readonly<Record<string, string>>
}

export interface MailPort {
  send(message: MailMessage): Promise<void>
}

export interface MemoryMailSink extends MailPort {
  readonly sent: readonly MailMessage[]
  clear(): void
}

export function createMemoryMailSink(): MemoryMailSink {
  const sent: MailMessage[] = []
  return {
    sent,
    send(message: MailMessage): Promise<void> {
      sent.push(message)
      return Promise.resolve()
    },
    clear(): void {
      sent.length = 0
    },
  }
}
