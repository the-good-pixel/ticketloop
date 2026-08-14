import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:4321'
export const OUTPUT_DIR = path.join(__dirname, 'output')

export const DESKTOP = {
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 2,
	videoSize: { width: 1920, height: 1080 },
}
