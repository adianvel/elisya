import { expect, test } from 'bun:test'

type WorkflowNode = { name: string; type: string; parameters: Record<string, any> }
const inbound = JSON.parse(await Bun.file(new URL('../../../integrations/n8n/workflows/palawa-whatsapp-inbound.json', import.meta.url)).text()) as {
  nodes: WorkflowNode[]
  connections: Record<string, { main: Array<Array<{ node: string }>> }>
}
const outbound = JSON.parse(await Bun.file(new URL('../../../integrations/n8n/workflows/palawa-whatsapp-outbound.json', import.meta.url)).text()) as { nodes: WorkflowNode[] }

test('the versioned inbound workflow calls the secured Elysia text and media contracts', () => {
  const nodes = new Map<string, Record<string, any>>(inbound.nodes.map((node) => [node.name, node.parameters]))
  expect(nodes.get('WAHA inbound')).toMatchObject({ authentication: 'headerAuth', responseMode: 'lastNode' })
  expect(nodes.get('Map WAHA message in Elysia')?.url).toBe('http://api:8000/integrations/n8n/whatsapp')
  expect(nodes.get('Run Elysia assistant')?.url).toBe('http://api:8000/chat/whatsapp')
  expect(nodes.get('Extract Hold ID')?.jsCode).toContain('payload.media?.url')
  expect(nodes.get('Download WAHA media')?.url).toContain('mediaUrl')
  expect(nodes.get('Submit proof to Elysia')?.url).toBe('http://api:8000/integrations/n8n/whatsapp/media')
  expect(nodes.get('Submit proof to Elysia')?.bodyParameters.parameters.map((field: { name: string }) => field.name)).toEqual(['wahaEvent', 'holdId', 'file'])
  expect(inbound.connections['Map WAHA message in Elysia'].main[0][0].node).toBe('Run Elysia assistant')
  expect(inbound.connections['Run Elysia assistant']).toBeUndefined()
})

test('the outbound callback authenticates the worker and waits for WAHA delivery', () => {
  const webhook = outbound.nodes.find((node) => node.name === 'Outbound notification')!
  const send = outbound.nodes.find((node) => node.name === 'Send WhatsApp text')!
  expect(webhook.parameters).toMatchObject({ authentication: 'headerAuth', responseMode: 'lastNode' })
  expect(send.parameters.url).toBe('http://waha:3000/api/sendText')
  expect(send.parameters.jsonBody).toContain('customerRef')
})
