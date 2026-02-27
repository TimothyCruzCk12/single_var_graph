import React, { useState, useRef, useCallback, useEffect } from 'react';

const WIDTH = 500;
const HEIGHT = 500;
const MIN = -5;
const MAX = 5;
const PADDING = 40;
const LINE_Y = HEIGHT / 2;
const lineLeft = PADDING;
const lineRight = WIDTH - PADDING;
const lineLength = lineRight - lineLeft;
/** Grid and number-line tick spacing (px per unit) */
const GRID_CELL = 30;
const fullUnit = GRID_CELL;
/** Line length so ticks are exactly fullUnit (30px) apart */
const effectiveLineLength = (MAX - MIN) * fullUnit;
const lineMargin = (lineLength - effectiveLineLength) / 2;
const lineLeftEffective = lineLeft + lineMargin;
const lineRightEffective = lineRight - lineMargin;
/** One full segment past -5 and 5 so arrows sit at -6 and 6 */
const EXTENDED_MIN = -6;
const EXTENDED_MAX = 6;
const lineStart = lineLeftEffective - fullUnit;
const lineEnd = lineRightEffective + fullUnit;
const extendedLength = lineEnd - lineStart;
/** Extra length for drawing the line and arrows only (segment scale unchanged) */
const ARROW_EXTENSION = fullUnit * 0.1;
const lineDrawStart = lineStart - ARROW_EXTENSION;
const lineDrawEnd = lineEnd + ARROW_EXTENSION;

/** Offset so the grid is centered in the container */
const GRID_OFFSET_X = (WIDTH - Math.floor(WIDTH / GRID_CELL) * GRID_CELL) / 2;
const GRID_OFFSET_Y = (HEIGHT - Math.floor(HEIGHT / GRID_CELL) * GRID_CELL) / 2;

/** Map a value in [EXTENDED_MIN, EXTENDED_MAX] to x (line includes one segment past -5 and 5) */
const valueToX = (value) =>
	lineStart + ((value - EXTENDED_MIN) / (EXTENDED_MAX - EXTENDED_MIN)) * extendedLength;

/** Map x (pixels) to number-line value over the full drawable range */
const xToValue = (x) =>
	EXTENDED_MIN + ((x - lineStart) / extendedLength) * (EXTENDED_MAX - EXTENDED_MIN);

/** Max pixels above/below the number line the drawn stroke can go; beyond this, y is clamped */
const DRAW_VERTICAL_MARGIN = 40;
const drawYMin = LINE_Y - DRAW_VERTICAL_MARGIN;
const drawYMax = LINE_Y + DRAW_VERTICAL_MARGIN;

/** Tolerance (px) to consider a segment endpoint "at" the graph end for drawing an arrow */
const END_ARROW_TOLERANCE = 2;

/** Empty circle (open point) detection: max horizontal span to count as "around one tick" */
const EMPTY_CIRCLE_MAX_SPAN = fullUnit * 0.9;
/** Min vertical extent (px) so we require some up/down motion */
const EMPTY_CIRCLE_MIN_VERTICAL = 12;
const EMPTY_CIRCLE_RADIUS = 8;
/** If path length (ink) is at least this many times the bounding-box perimeter, treat circle as filled */
const FILLED_CIRCLE_INK_RATIO = 1.3;

/** Split a horizontal segment into sub-segments that do not cross open circle interiors */
const splitSegmentAtOpenCircles = (seg, emptyCircleTicks) => {
	const x1 = seg[0].x;
	const x2 = seg[1].x;
	const y = seg[0].y;
	const xMin = Math.min(x1, x2);
	const xMax = Math.max(x1, x2);
	const gaps = emptyCircleTicks
		.map((tick) => {
			const cx = valueToX(tick);
			return [cx - EMPTY_CIRCLE_RADIUS, cx + EMPTY_CIRCLE_RADIUS];
		})
		.filter(([left, right]) => right > xMin && left < xMax)
		.map(([left, right]) => [Math.max(left, xMin), Math.min(right, xMax)]);
	gaps.sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const [l, r] of gaps) {
		if (merged.length && l <= merged[merged.length - 1][1]) {
			merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r);
		} else {
			merged.push([l, r]);
		}
	}
	const result = [];
	let current = xMin;
	for (const [l, r] of merged) {
		if (current < l - 1e-6) result.push([{ x: current, y }, { x: l, y }]);
		current = r;
	}
	if (current < xMax - 1e-6) result.push([{ x: current, y }, { x: xMax, y }]);
	return result;
};

/** Action types for undo/redo history */
const ACTION_SEGMENT = 'segment';
const ACTION_EMPTY_CIRCLE = 'emptyCircle';
const ACTION_FILLED_CIRCLE = 'filledCircle';

/** Reduce history slice to current segments and circle tick arrays */
const reduceHistoryToState = (historySlice) => {
	let segs = [];
	let emptyTicks = [];
	let filledTicks = [];
	for (const action of historySlice) {
		if (action.type === ACTION_SEGMENT) {
			segs = [...segs, action.data];
		} else if (action.type === ACTION_EMPTY_CIRCLE) {
			emptyTicks = emptyTicks.includes(action.tick) ? emptyTicks : [...emptyTicks, action.tick];
			filledTicks = filledTicks.filter((t) => t !== action.tick);
		} else if (action.type === ACTION_FILLED_CIRCLE) {
			filledTicks = filledTicks.includes(action.tick) ? filledTicks : [...filledTicks, action.tick];
			emptyTicks = emptyTicks.filter((t) => t !== action.tick);
		}
	}
	return { segments: segs, emptyCircleTicks: emptyTicks, filledCircleTicks: filledTicks };
};

const SingleVarGraph = () => {
	const tickValues = Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i);
	const [path, setPath] = useState([]);
	/** Ordered history of drawing actions for undo/redo */
	const [history, setHistory] = useState([]);
	const [historyIndex, setHistoryIndex] = useState(0);
	const { segments, emptyCircleTicks, filledCircleTicks } = reduceHistoryToState(
		history.slice(0, historyIndex)
	);
	const [isDrawing, setIsDrawing] = useState(false);
	const [showGlow, setShowGlow] = useState(true);
	const containerRef = useRef(null);
	const isDrawingRef = useRef(false);
	isDrawingRef.current = isDrawing;

	const historyIndexRef = useRef(0);
	historyIndexRef.current = historyIndex;

	const pushHistory = useCallback((action) => {
		const idx = historyIndexRef.current;
		setHistory((h) => [...h.slice(0, idx), action]);
		setHistoryIndex(idx + 1);
	}, []);

	/** Convert client coords to SVG. If forDrawing, y is preserved (free vertical); otherwise y is LINE_Y. */
	const clientToSvg = useCallback((clientX, clientY, { forDrawing = false } = {}) => {
		const el = containerRef.current;
		if (!el) return null;
		const rect = el.getBoundingClientRect();
		let x = clientX - rect.left;
		let y = clientY - rect.top;
		x = Math.round(Math.max(lineStart, Math.min(lineEnd, x)));
		if (!forDrawing) y = LINE_Y;
		else y = Math.round(Math.max(drawYMin, Math.min(drawYMax, y)));
		return { x, y };
	}, []);

	const startDrawing = useCallback(
		(clientX, clientY) => {
			const pt = clientToSvg(clientX, clientY, { forDrawing: true });
			if (pt) {
				setIsDrawing(true);
				setPath([pt]);
			}
		},
		[clientToSvg]
	);

	const moveDrawing = useCallback(
		(clientX, clientY) => {
			if (!isDrawing) return;
			const pt = clientToSvg(clientX, clientY, { forDrawing: true });
			if (pt) {
				setPath((prev) => {
					const last = prev[prev.length - 1];
					if (last && last.x === pt.x && last.y === pt.y) return prev;
					return [...prev, pt];
				});
			}
		},
		[isDrawing, clientToSvg]
	);

	const endDrawing = useCallback(() => {
		setIsDrawing(false);
		setPath((prev) => {
			if (prev.length < 2) return prev;
			const xs = prev.map((p) => p.x);
			const ys = prev.map((p) => p.y);
			const minX = Math.min(...xs);
			const maxX = Math.max(...xs);
			const minY = Math.min(...ys);
			const maxY = Math.max(...ys);
			const spanX = maxX - minX;
			const spanY = maxY - minY;
			// Total "ink": path length (sum of segment lengths)
			const pathLength = prev.length < 2 ? 0 : prev.slice(0, -1).reduce((sum, p, i) => {
				const q = prev[i + 1];
				return sum + Math.hypot(q.x - p.x, q.y - p.y);
			}, 0);
			const perimeter = 2 * (spanX + spanY) || 1;
			const inkRatio = pathLength / perimeter;
			// Detect "empty circle" gesture: small horizontal span, some vertical motion, multiple points
			if (
				prev.length >= 4 &&
				spanX < EMPTY_CIRCLE_MAX_SPAN &&
				spanY >= EMPTY_CIRCLE_MIN_VERTICAL
			) {
				const centerX = (minX + maxX) / 2;
				const centerVal = xToValue(centerX);
				const tick = Math.round(centerVal);
				const clampedTick = Math.max(MIN, Math.min(MAX, tick));
				// Lots of ink (scribbling/filling) -> filled circle regardless of outline
				if (inkRatio >= FILLED_CIRCLE_INK_RATIO) {
					pushHistory({ type: ACTION_FILLED_CIRCLE, tick: clampedTick });
				} else {
					pushHistory({ type: ACTION_EMPTY_CIRCLE, tick: clampedTick });
				}
				return [];
			}
			// Detect "filled circle" gesture: small horizontal span, little vertical motion (drawing on the line)
			if (
				prev.length >= 2 &&
				spanX < EMPTY_CIRCLE_MAX_SPAN &&
				spanY < EMPTY_CIRCLE_MIN_VERTICAL
			) {
				const centerX = (minX + maxX) / 2;
				const centerVal = xToValue(centerX);
				const tick = Math.round(centerVal);
				const clampedTick = Math.max(MIN, Math.min(MAX, tick));
				pushHistory({ type: ACTION_FILLED_CIRCLE, tick: clampedTick });
				return [];
			}
			const minVal = xToValue(minX);
			const maxVal = xToValue(maxX);
			// Snap to nearest tick: past halfway -> fill to that tick, else remove excess
			const leftTick = Math.round(minVal);
			const rightTick = Math.round(maxVal);
			const clampedLeft = Math.max(EXTENDED_MIN, Math.min(EXTENDED_MAX, leftTick));
			const clampedRight = Math.max(EXTENDED_MIN, Math.min(EXTENDED_MAX, rightTick));
			const startX = valueToX(clampedLeft);
			const endX = valueToX(clampedRight);
			const startPt = { x: startX, y: LINE_Y };
			const endPt = { x: endX, y: LINE_Y };
			if (startX === endX) return [startPt];
			pushHistory({ type: ACTION_SEGMENT, data: [startPt, endPt] });
			return [];
		});
	}, [pushHistory]);

	const handlePointerDown = useCallback(
		(e) => {
			e.preventDefault();
			startDrawing(e.clientX, e.clientY);
		},
		[startDrawing]
	);

	const handlePointerMove = useCallback(
		(e) => {
			moveDrawing(e.clientX, e.clientY);
		},
		[moveDrawing]
	);

	const handlePointerUp = useCallback(() => {
		endDrawing();
	}, [endDrawing]);

	// Touch handlers (for preventDefault on move to avoid scrolling)
	const handleTouchStart = useCallback(
		(e) => {
			if (e.touches.length === 1) {
				startDrawing(e.touches[0].clientX, e.touches[0].clientY);
			}
		},
		[startDrawing]
	);

	const handleTouchMove = useCallback(
		(e) => {
			if (e.touches.length === 1) {
				moveDrawing(e.touches[0].clientX, e.touches[0].clientY);
			}
		},
		[moveDrawing]
	);

	const handleTouchEnd = useCallback(() => {
		endDrawing();
	}, [endDrawing]);

	// Non-passive touch listener so we can preventDefault and avoid page scroll while drawing
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onTouchMove = (e) => {
			if (isDrawingRef.current && e.touches.length === 1) e.preventDefault();
		};
		el.addEventListener('touchmove', onTouchMove, { passive: false });
		return () => el.removeEventListener('touchmove', onTouchMove);
	}, []);

	const pathD =
		path.length < 2
			? ''
			: path.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
	const segmentPathD = (seg) =>
		seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

	const canUndo = historyIndex > 0;
	const canRedo = historyIndex < history.length;
	const canReset = history.length > 0;

	return (
		<div
			ref={containerRef}
			className="single-var-graph"
			style={{
				position: 'relative',
				width: WIDTH,
				height: HEIGHT,
				border: '1px solid #ccc',
				borderRadius: 4,
				overflow: 'hidden',
				backgroundColor: '#fff',
				touchAction: 'none',
				userSelect: 'none',
				WebkitUserSelect: 'none',
				MozUserSelect: 'none',
				msUserSelect: 'none',
			}}
			onMouseDown={handlePointerDown}
			onMouseMove={handlePointerMove}
			onMouseUp={handlePointerUp}
			onMouseLeave={handlePointerUp}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchEnd}
		>
			<div className={`segmented-glow-button simple-glow compact${!showGlow ? ' hide-orbit' : ''}`} style={{ position: 'absolute', top: 11, right: 12 }}>
				<div className="segment-container">
					<button
						type="button"
						className={`segment ${!canUndo ? 'inactive' : ''}`}
						onClick={() => {
							if (canUndo) setShowGlow(false);
							setHistoryIndex((i) => Math.max(0, i - 1));
						}}
						disabled={!canUndo}
					>
						Undo
					</button>
					<button
						type="button"
						className={`segment ${!canRedo ? 'inactive' : ''}`}
						onClick={() => {
							if (canRedo) setShowGlow(false);
							setHistoryIndex((i) => Math.min(history.length, i + 1));
						}}
						disabled={!canRedo}
					>
						Redo
					</button>
					<button
						type="button"
						className={`segment ${!canReset ? 'inactive' : ''}`}
						onClick={() => {
							if (canReset) setShowGlow(false);
							setHistory([]);
							setHistoryIndex(0);
						}}
						disabled={!canReset}
					>
						Reset
					</button>
				</div>
			</div>
			<svg width={WIDTH} height={HEIGHT} style={{ display: 'block' }}>
				<defs>
					<pattern
						id="grid"
						x={GRID_OFFSET_X}
						y={GRID_OFFSET_Y}
						width={GRID_CELL}
						height={GRID_CELL}
						patternUnits="userSpaceOnUse"
					>
						<path
							d={`M 0 0 L 0 ${GRID_CELL} M 0 0 L ${GRID_CELL} 0 M ${GRID_CELL} 0 L ${GRID_CELL} ${GRID_CELL} M 0 ${GRID_CELL} L ${GRID_CELL} ${GRID_CELL}`}
							stroke="#e6e6e6"
							strokeWidth="1"
							fill="none"
						/>
					</pattern>
				</defs>
				<rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />
				{/* Main horizontal line (stops at arrow bases so it doesn't overlap arrow tips) */}
				<line
					x1={lineDrawStart + 10}
					y1={LINE_Y}
					x2={lineDrawEnd - 10}
					y2={LINE_Y}
					stroke="#999999"
					strokeWidth={2}
				/>
				{/* Ticks and labels */}
				{tickValues.map((value) => {
					const x = valueToX(value);
					return (
						<g key={value}>
							<line
								x1={x}
								y1={LINE_Y}
								x2={x}
								y2={LINE_Y + 10}
								stroke="#999999"
								strokeWidth={1.5}
							/>
							<text
								x={x}
								y={LINE_Y + 26}
								textAnchor="middle"
								fontSize="14px"
								fontWeight="bold"
								fill="#999999"
								fontFamily="'Latin Modern Roman', serif"
							>
								{value < 0 ? '\u002D' + (-value) : value}
							</text>
						</g>
					);
				})}
				{/* Empty circles (open points) at ticks */}
				{emptyCircleTicks.map((tick) => (
					<circle
						key={`empty-${tick}`}
						cx={valueToX(tick)}
						cy={LINE_Y}
						r={EMPTY_CIRCLE_RADIUS}
						fill="none"
						stroke="#1967d2"
						strokeWidth={2}
					/>
				))}
				{/* Filled circles (closed points) at ticks */}
				{filledCircleTicks.map((tick) => (
					<circle
						key={`filled-${tick}`}
						cx={valueToX(tick)}
						cy={LINE_Y}
						r={EMPTY_CIRCLE_RADIUS}
						fill="#1967d2"
						stroke="#1967d2"
						strokeWidth={2}
					/>
				))}
				{/* Completed line segments (split at open circles so line doesn't show inside them) */}
				{segments
					.flatMap((seg) => splitSegmentAtOpenCircles(seg, emptyCircleTicks))
					.map((seg, idx) => (
						<path
							key={idx}
							d={segmentPathD(seg)}
							fill="none"
							stroke="#1967d2"
							strokeWidth={4}
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					))}
				{/* Gray number-line arrows (drawn first so blue segment arrows can cover them) */}
				<polygon
					points={`${lineDrawStart + 10},${LINE_Y - 7} ${lineDrawStart},${LINE_Y} ${lineDrawStart + 10},${LINE_Y + 7}`}
					fill="#999999"
				/>
				<polygon
					points={`${lineDrawEnd - 10},${LINE_Y - 7} ${lineDrawEnd},${LINE_Y} ${lineDrawEnd - 10},${LINE_Y + 7}`}
					fill="#999999"
				/>
				{/* Arrows on drawn segments that extend to the graph ends (same position/size as gray arrows so they cover them) */}
				{segments.flatMap((seg, segIdx) => {
					const atLeftEnd = seg[0].x <= lineStart + END_ARROW_TOLERANCE;
					const atRightEnd = seg[1].x >= lineEnd - END_ARROW_TOLERANCE;
					const arrows = [];
					if (atLeftEnd) {
						arrows.push(
							<polygon
								key={`${segIdx}-left`}
								points={`${lineDrawStart + 10},${LINE_Y - 7} ${lineDrawStart},${LINE_Y} ${lineDrawStart + 10},${LINE_Y + 7}`}
								fill="#1967d2"
							/>
						);
					}
					if (atRightEnd) {
						arrows.push(
							<polygon
								key={`${segIdx}-right`}
								points={`${lineDrawEnd - 10},${LINE_Y - 7} ${lineDrawEnd},${LINE_Y} ${lineDrawEnd - 10},${LINE_Y + 7}`}
								fill="#1967d2"
							/>
						);
					}
					return arrows;
				})}
				{/* Current stroke in progress */}
				{path.length >= 2 && (
					<path
						d={pathD}
						fill="none"
						stroke="#1967d2"
						strokeWidth={4}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				)}
			</svg>
		</div>
	);
};

export default SingleVarGraph;