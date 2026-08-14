import { interpolate, useCurrentFrame } from 'remotion'
import { COLORS } from '../theme'

type SpotlightEvent = {
	t: number
	type: 'spotlight'
	x: number
	y: number
	w: number
	h: number
	duration: number
	label?: string
}

type Props = {
	events: SpotlightEvent[]
	fps: number
	skipMs?: number
}

export const Spotlights = ({ events, fps, skipMs = 0 }: Props) => {
	const frame = useCurrentFrame()
	const nowMs = (frame / fps) * 1000 + skipMs

	return (
		<>
			{events.map((e, i) => {
				const startMs = e.t
				const endMs = e.t + e.duration
				if (nowMs < startMs || nowMs > endMs + 250) return null

				const local = nowMs - startMs
				const opacity = interpolate(
					local,
					[0, 180, e.duration - 220, e.duration],
					[0, 1, 1, 0],
					{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
				)
				const scale = interpolate(local, [0, 220], [1.08, 1], { extrapolateRight: 'clamp' })

				return (
					<div
						key={i}
						style={{
							position: 'absolute',
							left: e.x,
							top: e.y,
							width: e.w,
							height: e.h,
							opacity,
							transform: `scale(${scale})`,
							transformOrigin: 'center',
							borderRadius: Math.min(18, Math.min(e.w, e.h) * 0.25),
							boxShadow: `0 0 0 4px ${COLORS.teal}, 0 0 0 10px rgba(46,199,184,0.22), 0 12px 32px rgba(18,143,132,0.35)`,
							pointerEvents: 'none',
						}}
					/>
				)
			})}
		</>
	)
}
