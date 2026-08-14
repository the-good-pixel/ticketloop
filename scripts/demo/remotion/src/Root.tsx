import { Composition } from 'remotion'
import { FPS, WIDTH, HEIGHT } from './Chrome'
import { WorkflowBuilder, WORKFLOW_BUILDER_DURATION } from './compositions/WorkflowBuilder'

// Register one <Composition> per video. The id is what you pass to
// `npx remotion render src/index.ts <id> out/<id>.mp4`.
export const Root = () => {
	return (
		<>
			<Composition
				id="WorkflowBuilder"
				component={WorkflowBuilder}
				durationInFrames={WORKFLOW_BUILDER_DURATION}
				fps={FPS}
				width={WIDTH}
				height={HEIGHT}
			/>
		</>
	)
}
