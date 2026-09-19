import { enqueueTask } from './lib/tasks'

type WhatsAppNotification = {
  eventKey: string
  customerRef: string
  text: string
}

export function notifyWhatsApp(input: WhatsAppNotification): void {
  void enqueueTask('notify.whatsapp', input).catch((error) => {
    console.error({ task: 'notify.whatsapp', eventKey: input.eventKey, err: error }, 'notification enqueue failed')
  })
}
