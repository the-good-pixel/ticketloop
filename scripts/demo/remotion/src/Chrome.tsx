import {
	AbsoluteFill,
	OffthreadVideo,
	staticFile,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion'
import { COLORS, FONT } from './theme'
import { Cursor } from './components/Cursor'
import { Spotlights } from './components/Spotlight'

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080
const TITLE_END = 60

export type Callout = { startFrame: number; endFrame: number; text: string; subtitle?: string }
type AnyEvent = { t: number; type: string; x: number; y: number; w?: number; h?: number; duration?: number; label?: string }

export type DemoProps = {
	videoFile: string
	events: AnyEvent[]
	clipTrimMs: number
	titleMain: string
	titleSub: string
	watermarkLabel: string
	callouts: Callout[]
	ctaStart: number
	ctaHeadline: string
	ctaSub: string
}

const LogoWhite = ({ h = 40 }: { h?: number }) => (
	<div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: h * 0.28, color: COLORS.white }}>
		<div style={{ width: h * 0.34, height: h * 0.34, borderRadius: '50%', background: COLORS.teal }} />
		<div style={{ fontSize: h, lineHeight: 1, fontWeight: 800, letterSpacing: '-0.04em' }}>ticketloop</div>
	</div>
)

// Auto-calibrate clip trim, chyron windows, CTA start and total duration from
// the recorded spotlight events. `copy` maps 1:1 (in order) to the spotlights.
export function planAll(
	eventsJson: { events: AnyEvent[] },
	copy: { text: string; subtitle?: string }[],
	leadMs = 2500,
	fromFirstPointer = false, // start the clip at the first cursor action (e.g. a click), not the first ring
) {
	const events = eventsJson.events
	const spots = events.filter((e) => e.type === 'spotlight')
	const pointers = events.filter((e) => e.type !== 'spotlight')
	const anchor = fromFirstPointer && pointers.length ? pointers[0].t : spots[0]?.t ?? 3000
	const clipTrimMs = Math.max(0, anchor - leadMs)
	const f = (t: number) => Math.round(((t - clipTrimMs) / 1000) * FPS)
	const callouts: Callout[] = spots.map((s, i) => {
		const start = Math.max(0, f(s.t) - 6)
		const next = spots[i + 1]
		const end = next ? f(next.t) - 6 : f(s.t + (s.duration ?? 1800)) + 24
		return { startFrame: start, endFrame: end, text: copy[i]?.text ?? '', subtitle: copy[i]?.subtitle }
	})
	const last = spots[spots.length - 1]
	const ctaStart = last ? f(last.t + (last.duration ?? 1800)) + 18 : 120
	const duration = ctaStart + 82
	return { clipTrimMs, events, callouts, ctaStart, duration }
}

export const DemoVideo = (props: DemoProps) => {
	const { fps } = useVideoConfig()
	const pointer = props.events.filter((e) => e.type !== 'spotlight') as any
	const spots = props.events.filter((e) => e.type === 'spotlight') as any

	return (
		<AbsoluteFill style={{ backgroundColor: COLORS.bg, fontFamily: FONT }}>
			<OffthreadVideo
				src={staticFile(props.videoFile)}
				startFrom={Math.round((props.clipTrimMs / 1000) * FPS)}
				style={{ width: '100%', height: '100%', objectFit: 'cover' }}
			/>

			<Cursor events={pointer} fps={fps} skipMs={props.clipTrimMs} />
			<Spotlights events={spots} fps={fps} skipMs={props.clipTrimMs} />

			<OpeningTitle main={props.titleMain} sub={props.titleSub} />
			<Watermark label={props.watermarkLabel} />
			<BottomChyron callouts={props.callouts} />
			<EndCTA start={props.ctaStart} headline={props.ctaHeadline} sub={props.ctaSub} />
		</AbsoluteFill>
	)
}

const OpeningTitle = ({ main, sub }: { main: string; sub: string }) => {
	const frame = useCurrentFrame()
	if (frame > TITLE_END) return null
	const leave = interpolate(frame, [TITLE_END - 10, TITLE_END], [1, 0], { extrapolateLeft: 'clamp' })
	return (
		<AbsoluteFill
			style={{
				background:
					'linear-gradient(180deg, rgba(20,20,20,0.82) 0%, rgba(20,20,20,0.4) 55%, rgba(20,20,20,0) 85%)',
				opacity: leave,
				pointerEvents: 'none',
			}}
		>
			<div style={{ position: 'absolute', top: 230, left: 0, right: 0, textAlign: 'center' }}>
				<div
					style={{
						fontSize: 104,
						fontWeight: 800,
						color: COLORS.white,
						letterSpacing: '-0.03em',
						lineHeight: 1.05,
						textShadow: '0 8px 40px rgba(20,20,20,0.6)',
					}}
				>
					{main}
				</div>
				<div
					style={{
						marginTop: 26,
						fontSize: 36,
						fontWeight: 600,
						color: COLORS.tealLight,
						letterSpacing: '0.01em',
						textShadow: '0 2px 16px rgba(20,20,20,0.55)',
					}}
				>
					{sub}
				</div>
			</div>
		</AbsoluteFill>
	)
}

const Watermark = ({ label }: { label: string }) => {
	const frame = useCurrentFrame()
	const appear = interpolate(frame, [TITLE_END - 20, TITLE_END], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	})
	return (
		<div
			style={{
				position: 'absolute',
				top: 40,
				left: 44,
				display: 'flex',
				alignItems: 'center',
				gap: 24,
				minWidth: 470,
				padding: '20px 32px',
				borderRadius: 18,
				background: 'rgba(20,20,20,0.92)',
				boxShadow: '0 12px 40px rgba(20,20,20,0.35)',
				opacity: appear,
				pointerEvents: 'none',
			}}
		>
			<LogoWhite h={34} />
			<div style={{ width: 2, height: 34, background: 'rgba(255,255,255,0.18)' }} />
			<div style={{ fontSize: 28, fontWeight: 700, color: COLORS.white, letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>
				{label}
			</div>
		</div>
	)
}

const BottomChyron = ({ callouts }: { callouts: Callout[] }) => {
	const frame = useCurrentFrame()
	const active = callouts.find((c) => frame >= c.startFrame && frame <= c.endFrame)
	if (!active) return null
	const local = frame - active.startFrame
	const dur = active.endFrame - active.startFrame
	const fadeIn = interpolate(local, [0, 5], [0, 1], { extrapolateRight: 'clamp' })
	const fadeOut = interpolate(local, [dur - 5, dur], [1, 0], { extrapolateLeft: 'clamp' })
	const opacity = Math.min(fadeIn, fadeOut)
	return (
		<>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					bottom: 0,
					height: 320,
					background:
						'linear-gradient(180deg, rgba(20,20,20,0) 0%, rgba(20,20,20,0.78) 55%, rgba(20,20,20,0.96) 100%)',
					opacity,
					pointerEvents: 'none',
				}}
			/>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					bottom: 0,
					padding: '46px 88px 54px 88px',
					opacity,
					pointerEvents: 'none',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
					<div style={{ width: 10, height: 64, borderRadius: 4, background: COLORS.yellow }} />
					<div style={{ flex: 1 }}>
						<div
							style={{
								fontSize: 54,
								fontWeight: 800,
								color: COLORS.white,
								letterSpacing: '-0.02em',
								lineHeight: 1.1,
							}}
						>
							{active.text}
						</div>
						{active.subtitle && (
							<div
								style={{
									marginTop: 10,
									fontSize: 26,
									fontWeight: 500,
									color: COLORS.tealLight,
									letterSpacing: '0.01em',
									lineHeight: 1.4,
								}}
							>
								{active.subtitle}
							</div>
						)}
					</div>
				</div>
			</div>
		</>
	)
}

const EndCTA = ({ start, headline, sub }: { start: number; headline: string; sub: string }) => {
	const frame = useCurrentFrame()
	if (frame < start) return null
	const appear = interpolate(frame, [start, start + 8], [0, 1], { extrapolateRight: 'clamp' })
	return (
		<AbsoluteFill
			style={{
				background: COLORS.ink,
				alignItems: 'center',
				justifyContent: 'center',
				opacity: appear,
				pointerEvents: 'none',
			}}
		>
			<LogoWhite h={74} />
			<div
				style={{
					marginTop: 46,
					fontSize: 58,
					fontWeight: 800,
					color: COLORS.white,
					letterSpacing: '-0.02em',
					textAlign: 'center',
					lineHeight: 1.15,
					maxWidth: 1400,
				}}
			>
				{headline}
			</div>
			<div style={{ marginTop: 16, fontSize: 28, fontWeight: 500, color: COLORS.tealLight }}>{sub}</div>
			<div
				style={{
					marginTop: 32,
					display: 'inline-flex',
					alignItems: 'center',
					padding: '20px 44px',
					borderRadius: 999,
					background: COLORS.tealDeep,
					boxShadow: '0 18px 56px rgba(18,143,132,0.5)',
				}}
			>
				<div style={{ fontSize: 36, fontWeight: 700, color: COLORS.white, letterSpacing: '0.02em' }}>
					github.com/the-good-pixel/ticketloop
				</div>
			</div>
		</AbsoluteFill>
	)
}
