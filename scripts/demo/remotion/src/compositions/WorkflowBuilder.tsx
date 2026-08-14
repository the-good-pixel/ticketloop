import { loadFont } from '@remotion/google-fonts/Inter'
import { DemoVideo, planAll } from '../Chrome'
import eventsJson from '../../public/workflow-builder.events.json'

loadFont('normal', { weights: ['400', '500', '600', '700', '800'] })

const COPY = [
	{ text: 'Tickets become visible, resumable work', subtitle: 'See the path, outcome, and checkpoint at a glance.' },
	{ text: 'One workflow for each project', subtitle: 'Choose the process, ticket scope, and review policy.' },
	{ text: 'Edit the process visually', subtitle: 'Branch by ticket type and repair failures with bounded loops.' },
	{ text: 'Tune every step without rewriting the flow', subtitle: 'Set the model, effort, and project-specific instruction.' },
]

const PLAN = planAll(eventsJson as any, COPY)

export const WORKFLOW_BUILDER_DURATION = PLAN.duration

export const WorkflowBuilder = () => (
	<DemoVideo
		videoFile="workflow-builder.mp4"
		events={PLAN.events}
		clipTrimMs={PLAN.clipTrimMs}
		titleMain="Build the workflow your project needs"
		titleSub="Local coding agents, clear paths, human-reviewed pull requests"
		watermarkLabel="Workflow builder"
		callouts={PLAN.callouts}
		ctaStart={PLAN.ctaStart}
		ctaHeadline="Turn trusted tickets into repeatable work"
		ctaSub="Open source · runs with Claude Code or Codex"
	/>
)
