import { createEvent, FunctionNode, InMemorySessionService, Runner, Workflow, type NodeContext, type EdgeItem } from '@google/adk'
import type { CompiledLoopNode, CompiledPhase, CompiledStepNode, ExecutionPlan } from '../../src/catalog/compile.js'
import type { WorkflowDriver, WorkflowExecution, WorkflowSignal } from '../../src/loop/interpreter.js'

type Packet = { signal: WorkflowSignal; source: string }
type Handler = (ctx: NodeContext, input: unknown) => Promise<unknown> | unknown

/** Compiles Ticketloop's validated tree to actual ADK edges; does not call its tree walker. */
export function adkDriver(plan: ExecutionPlan, metrics: { events: number; nodes: number }): WorkflowDriver {
  const errors = plan.diagnostics.filter(d => d.level === 'error')
  if (errors.length) throw new Error(errors.map(d => d.message).join('; '))
  return async (runtime: WorkflowExecution) => {
    const edges: EdgeItem[] = []
    const loops = new Map<string, { phase: CompiledLoopNode; entries: FunctionNode[]; count: number; last: string; next: FunctionNode }>()
    let sequence = 0
    let terminal: WorkflowSignal = {type:'continue'}
    let stepError: unknown
    const make = (name: string, handler: Handler) => {
      metrics.nodes++
      return new FunctionNode(`n${sequence++}_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`, handler)
    }
    const end = make('end', (_ctx, input) => {
      const packet = input as Packet | undefined
      if (packet?.signal && (packet.signal.type === 'stop' || packet.signal.type === 'suspend')) terminal = packet.signal
      return terminal
    })
    const continuePacket = (): Packet => ({signal:{type:'continue'},source:''})

    function transition(sig: WorkflowSignal, source: string, next: FunctionNode, exit?: FunctionNode): string {
      if (sig.type === 'continue') return next.name
      if (sig.type === 'exit-loop') {
        if (!exit) throw new Error(`Unsupported exit-loop outside a loop: ${source}`)
        return exit.name
      }
      if (sig.type !== 'repair') return end.name
      const owner = loops.get(sig.loopId)
      if (!owner) throw new Error(`Unknown repair target ${sig.loopId}`)
      const signature = `${source}::${sig.detail}`
      const insideGate = owner.phase.gates.some(g => g.id === source)
      const noProgress = insideGate && signature === owner.last
      if (owner.count >= owner.phase.maxIterations || noProgress) {
        const note = noProgress ? `"${sig.loopId}" made no progress between attempts.`
          : `"${sig.loopId}" did not clear within ${owner.phase.maxIterations} attempt(s).`
        runtime.degraded(note)
        terminal = owner.phase.noProgress === 'stop'
          ? {type:'stop',terminal:runtime.hasPr()?'partial':'failed',note}
          : {type:'continue'}
        return owner.phase.noProgress === 'stop' ? end.name : owner.next.name
      }
      if (insideGate) owner.last = signature
      owner.count++
      runtime.findings(`The "${source}" step reported problems:\n${sig.detail.slice(0,1500)}`)
      return owner.entries[owner.count - 1].name
    }

    function step(compiled: CompiledStepNode, next: FunctionNode, iteration?: number, exit?: FunctionNode, ownerId?: string): FunctionNode {
      const current = make(`${compiled.id}_${iteration ?? 0}`, async () => {
        if (ownerId) loops.get(ownerId)!.count = iteration!
        let signal: WorkflowSignal
        try { signal = await runtime.step(compiled, iteration) }
        catch (error) { stepError = error; return createEvent({route:end.name,output:continuePacket()}) }
        return createEvent({route:transition(signal, compiled.id, next, exit),output:{signal,source:compiled.id}})
      })
      // Destinations are resolved after every loop entry has been allocated.
      pending.push({current,next,exit})
      return current
    }
    const pending: {current: FunctionNode; next: FunctionNode; exit?: FunctionNode}[] = []
    function compile(phases: CompiledPhase[], continuation: FunctionNode): FunctionNode {
      let next = continuation
      for (const phase of [...phases].reverse()) {
        if (phase.kind === 'step') next = step(phase,next)
        else if (phase.kind === 'stop') {
          const stop = make(phase.id, () => {
            terminal = {type:'stop',terminal:phase.terminal,outcome:phase.outcome as never,note:phase.note,reported:phase.reported}
            return {signal:terminal,source:phase.id}
          })
          edges.push([stop,end]); next = stop
        } else if (phase.kind === 'branch') {
          const destinations: Record<string,FunctionNode> = {}
          for (const [value,children] of Object.entries(phase.cases)) destinations[value] = compile(children,next)
          const fallback = Array.isArray(phase.default) ? compile(phase.default,next) : phase.default === 'stop' ? end : next
          const branch = make(phase.id, () => {
            const value = runtime.branch(phase)
            if (!destinations[value ?? ''] && phase.default === 'stop') terminal = {type:'stop',terminal:'skipped',note:`No branch matched ${phase.on.field}.`}
            return createEvent({route:(destinations[value ?? ''] ?? fallback).name,output:continuePacket()})
          })
          const map = Object.fromEntries([...Object.values(destinations),fallback].map(n => [n.name,n]))
          edges.push([branch,map]); next = branch
        } else {
          const owner = {phase,entries:[] as FunctionNode[],count:1,last:'',next}
          loops.set(phase.id,owner)
          for (let iteration = 1; iteration <= phase.maxIterations; iteration++) {
            let entry = next
            for (const gate of [...phase.gates].reverse()) entry = step(gate,entry,iteration,next)
            entry = step(phase.repair,entry,iteration,next,phase.id)
            owner.entries.push(entry)
          }
          next = owner.entries[0]
        }
      }
      return next
    }
    const start = compile(plan.phases,end)
    for (const {current,next,exit} of pending) {
      const destinations = [next,end,...(exit?[exit]:[]),...[...loops.values()].flatMap(l => [...l.entries,l.next])]
      edges.push([current,Object.fromEntries(destinations.map(n => [n.name,n]))])
    }
    edges.push(['START',start])
    const workflow = new Workflow({name:'ticketloop_evaluation',edges,maxConcurrency:1})
    // Ticketloop checkpoints remain authoritative in this compatibility probe.
    // Native ADK persistent recovery is evaluated independently in recovery.ts.
    const sessions = new InMemorySessionService()
    await sessions.createSession({appName:'evaluation',userId:'local',sessionId:'run'})
    const runner = new Runner({appName:'evaluation',agent:workflow,sessionService:sessions})
    for await (const event of runner.runAsync({userId:'local',sessionId:'run',newMessage:{role:'user',parts:[{text:'run'}]}})) {
      metrics.events++
      if (event.errorMessage || event.errorCode) throw new Error(event.errorMessage || event.errorCode)
    }
    if (stepError) throw stepError
    return terminal
  }
}
