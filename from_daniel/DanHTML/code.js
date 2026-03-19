"use strict";
// DanHTML - Figma to HTML Export Plugin
// This plugin exports selected Figma frames to HTML/CSS
const EXPORTER_VERSION = '2026-03-09-dash-stroke-svg-v2';
// Convert Figma color to CSS rgba
function figmaColorToCss(color, opacity = 1) {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    if (opacity < 1) {
        return `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`;
    }
    return `rgb(${r}, ${g}, ${b})`;
}
async function ensureFontsLoadedForTextNode(textNode) {
    // Loading fonts is required before reading characters in many cases.
    // Use styled segments to support mixed fonts.
    try {
        const segments = textNode.getStyledTextSegments(['fontName']);
        const seen = new Set();
        for (const seg of segments) {
            const fontName = seg.fontName;
            if (!fontName || fontName === figma.mixed)
                continue;
            const key = `${fontName.family}::${fontName.style}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            await figma.loadFontAsync(fontName);
        }
    }
    catch (_) {
        // Fallback to node.fontName when segments API isn't available
        const fn = textNode.fontName;
        if (fn && fn !== figma.mixed && typeof fn !== 'symbol') {
            await figma.loadFontAsync(fn);
        }
    }
}
// Generate a valid CSS class name from node name
function generateClassName(name, id) {
    const cleanName = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const shortId = id.replace(/[:;]/g, '-');
    // Ensure it starts with a letter to be a valid CSS class
    const baseName = (cleanName || 'element');
    const safeName = /^[a-z]/.test(baseName) ? baseName : `class-${baseName}`;
    return `${safeName}-${shortId}`;
}
// Check if a VECTOR or LINE node is a separator line (one dimension is ~0 with a visible stroke).
// These should be rendered as CSS-styled divs, not SVG images.
function isSeparatorLine(node) {
    if (node.type !== 'VECTOR' && node.type !== 'LINE')
        return null;
    const w = 'width' in node ? node.width : 0;
    const h = 'height' in node ? node.height : 0;
    // One dimension must be ~0 and the other must be meaningful
    const isHorizontal = h <= 1 && w > 1;
    const isVertical = w <= 1 && h > 1;
    if (!isHorizontal && !isVertical)
        return null;
    // Must have a visible stroke to render as a line
    if (!('strokes' in node) || !node.strokes || !Array.isArray(node.strokes))
        return null;
    const strokes = node.strokes;
    for (const stroke of strokes) {
        if (stroke.visible === false)
            continue;
        if (stroke.type === 'SOLID') {
            const opacity = stroke.opacity !== undefined ? stroke.opacity : 1;
            const color = figmaColorToCss(stroke.color, opacity);
            const weight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
            return { direction: isHorizontal ? 'horizontal' : 'vertical', strokeWeight: weight, strokeColor: color };
        }
    }
    return null;
}
// Check if node is an icon (small vector-based element)
function isIconNode(node) {
    if ('children' in node) {
        const hasOnlyVectors = node.children.every((child) => child.type === 'VECTOR' || child.type === 'BOOLEAN_OPERATION' ||
            child.type === 'RECTANGLE' || child.type === 'ELLIPSE' ||
            child.type === 'LINE' || child.type === 'POLYGON' || child.type === 'STAR' ||
            (child.type === 'FRAME' && isIconNode(child)) ||
            (child.type === 'GROUP' && isIconNode(child)));
        const isSmall = node.width <= 32 && node.height <= 32;
        const isReasonablySized = node.width <= 64 && node.height <= 64;
        const nameIndicatesIcon = node.name.toLowerCase().includes('icon') ||
            node.name.toLowerCase().includes('trash') ||
            node.name.toLowerCase().includes('pencil') ||
            node.name.toLowerCase().includes('search') ||
            node.name.toLowerCase().includes('chevron') ||
            node.name.toLowerCase().includes('arrow') ||
            node.name.toLowerCase().includes('x-lg') ||
            node.name.toLowerCase().includes('close');
        return (hasOnlyVectors && isSmall) || (nameIndicatesIcon && isReasonablySized);
    }
    return false;
}
// Get fill styles
function getFillStyles(node) {
    const styles = [];
    if ('fills' in node && node.fills && Array.isArray(node.fills)) {
        const fills = node.fills;
        for (const fill of fills) {
            if (fill.visible === false)
                continue;
            if (fill.type === 'SOLID') {
                const opacity = fill.opacity !== undefined ? fill.opacity : 1;
                styles.push(`background-color: ${figmaColorToCss(fill.color, opacity)};`);
            }
            else if (fill.type === 'GRADIENT_LINEAR') {
                const stops = fill.gradientStops.map((stop) => {
                    const color = figmaColorToCss(stop.color, stop.color.a || 1);
                    return `${color} ${Math.round(stop.position * 100)}%`;
                }).join(', ');
                styles.push(`background: linear-gradient(${stops});`);
            }
        }
    }
    return styles;
}
function getNodeDashPattern(node) {
    if ('dashPattern' in node && Array.isArray(node.dashPattern)) {
        return node.dashPattern;
    }
    return [];
}
function hasVisibleSolidStroke(node) {
    if (!('strokes' in node) || !node.strokes || !Array.isArray(node.strokes))
        return false;
    const strokes = node.strokes;
    return strokes.some((stroke) => stroke.visible !== false && stroke.type === 'SOLID');
}
// CSS borders cannot represent Figma's dash/gap/cap/join controls accurately.
// For dashed strokes, export the node as SVG so dash settings are preserved.
function shouldExportNodeAsSvgForStroke(node) {
    if (node.type === 'TEXT')
        return false;
    if (!hasVisibleSolidStroke(node))
        return false;
    const dashPattern = getNodeDashPattern(node);
    return dashPattern.some((segment) => typeof segment === 'number' && segment > 0.01);
}
// Get stroke styles
function getStrokeStyles(node) {
    const styles = [];
    if ('strokes' in node && node.strokes && Array.isArray(node.strokes)) {
        const strokes = node.strokes;
        const strokeAlign = 'strokeAlign' in node ? node.strokeAlign : 'INSIDE';
        const dashPattern = getNodeDashPattern(node);
        // CSS cannot express custom dash lengths for borders directly.
        // If Figma has any dash pattern, map it to dashed border/outline style.
        const hasDashPattern = dashPattern.some((segment) => typeof segment === 'number' && segment > 0.01);
        const strokeStyle = hasDashPattern ? 'dashed' : 'solid';
        for (const stroke of strokes) {
            if (stroke.visible === false)
                continue;
            if (stroke.type === 'SOLID') {
                const opacity = stroke.opacity !== undefined ? stroke.opacity : 1;
                const strokeWeight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
                const color = figmaColorToCss(stroke.color, opacity);
                if (strokeAlign === 'OUTSIDE') {
                    // Outside strokes don't reduce content area in Figma.
                    // Use outline (doesn't affect box model) or box-shadow as fallback.
                    styles.push(`outline: ${strokeWeight}px ${strokeStyle} ${color};`);
                    styles.push(`outline-offset: 0px;`);
                }
                else if (strokeAlign === 'CENTER') {
                    // Center strokes straddle the edge — half inside, half outside.
                    // Use border for the visual, but note content area shrinks by full weight in CSS.
                    // A box-shadow can approximate without affecting layout, but border is more compatible.
                    styles.push(`border: ${strokeWeight}px ${strokeStyle} ${color};`);
                }
                else {
                    // INSIDE (default) — border-box handles this correctly
                    styles.push(`border: ${strokeWeight}px ${strokeStyle} ${color};`);
                }
            }
        }
    }
    return styles;
}
// Get corner radius styles
function getCornerRadiusStyles(node) {
    const styles = [];
    let addedRadius = false;
    if ('cornerRadius' in node) {
        const radius = node.cornerRadius;
        if (typeof radius === 'number' && radius > 0) {
            styles.push(`border-radius: ${radius}px;`);
            addedRadius = true;
        }
    }
    // Check for mixed radius.
    // Note: Figma can sometimes report cornerRadius as mixed even when the individual
    // radii are all equal. In that case we still need to emit a border-radius.
    if (!addedRadius && 'topLeftRadius' in node) {
        const tl = node.topLeftRadius || 0;
        const tr = node.topRightRadius || 0;
        const br = node.bottomRightRadius || 0;
        const bl = node.bottomLeftRadius || 0;
        const any = (tl > 0 || tr > 0 || br > 0 || bl > 0);
        if (any) {
            if (tl === tr && tr === br && br === bl) {
                styles.push(`border-radius: ${tl}px;`);
            }
            else {
                styles.push(`border-radius: ${tl}px ${tr}px ${br}px ${bl}px;`);
            }
        }
    }
    return styles;
}
// Get shadow styles
function getShadowStyles(node) {
    const styles = [];
    if ('effects' in node && node.effects) {
        const shadows = [];
        for (const effect of node.effects) {
            if (effect.visible === false)
                continue;
            if (effect.type === 'DROP_SHADOW') {
                const color = figmaColorToCss(effect.color, effect.color.a || 1);
                const x = effect.offset.x;
                const y = effect.offset.y;
                const blur = effect.radius;
                const spread = effect.spread || 0;
                shadows.push(`${x}px ${y}px ${blur}px ${spread}px ${color}`);
            }
            else if (effect.type === 'INNER_SHADOW') {
                const color = figmaColorToCss(effect.color, effect.color.a || 1);
                const x = effect.offset.x;
                const y = effect.offset.y;
                const blur = effect.radius;
                const spread = effect.spread || 0;
                shadows.push(`inset ${x}px ${y}px ${blur}px ${spread}px ${color}`);
            }
        }
        if (shadows.length > 0) {
            styles.push(`box-shadow: ${shadows.join(', ')};`);
        }
    }
    return styles;
}
// Get text styles
function getTextStyles(node) {
    const styles = [];
    // Text case
    if ('textCase' in node && typeof node.textCase === 'string') {
        const textCase = node.textCase;
        if (textCase === 'UPPER')
            styles.push('text-transform: uppercase;');
        else if (textCase === 'LOWER')
            styles.push('text-transform: lowercase;');
        else if (textCase === 'TITLE')
            styles.push('text-transform: capitalize;');
    }
    // Resolve font properties — node-level properties can be `figma.mixed` (a symbol)
    // when text has mixed styles (common in component instances or overridden text).
    // Fall back to the first styled text segment to get concrete values.
    let fontFamily = null;
    let fontStyleStr = null; // e.g. "Medium Italic"
    let resolvedFontSize = null;
    let resolvedLineHeight = null;
    let resolvedLetterSpacing = null;
    if (node.fontName && typeof node.fontName !== 'symbol') {
        fontFamily = node.fontName.family;
        fontStyleStr = node.fontName.style;
    }
    if (node.fontSize && typeof node.fontSize === 'number') {
        resolvedFontSize = node.fontSize;
    }
    if (node.lineHeight && typeof node.lineHeight !== 'symbol') {
        resolvedLineHeight = node.lineHeight;
    }
    if (node.letterSpacing && typeof node.letterSpacing !== 'symbol') {
        resolvedLetterSpacing = node.letterSpacing;
    }
    // Fallback: use getStyledTextSegments for any missing properties
    if (!fontFamily || !fontStyleStr || resolvedFontSize === null) {
        try {
            const segs = node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight', 'letterSpacing']);
            if (segs && segs.length > 0) {
                const seg = segs[0];
                if (!fontFamily && seg.fontName && typeof seg.fontName !== 'symbol') {
                    fontFamily = seg.fontName.family;
                    fontStyleStr = seg.fontName.style;
                }
                if (resolvedFontSize === null && typeof seg.fontSize === 'number') {
                    resolvedFontSize = seg.fontSize;
                }
                if (!resolvedLineHeight && seg.lineHeight && typeof seg.lineHeight !== 'symbol') {
                    resolvedLineHeight = seg.lineHeight;
                }
                if (!resolvedLetterSpacing && seg.letterSpacing && typeof seg.letterSpacing !== 'symbol') {
                    resolvedLetterSpacing = seg.letterSpacing;
                }
            }
        }
        catch (_) { /* segments API may not be available */ }
    }
    // Font family & weight/style
    if (fontFamily && fontStyleStr) {
        styles.push(`font-family: '${fontFamily}', sans-serif;`);
        // Font weight - more detailed mapping
        // Order matters: more specific names (e.g. "extra bold") must be checked
        // before less specific ones (e.g. "bold") to avoid incorrect matches.
        const style = fontStyleStr.toLowerCase();
        if (style.includes('black') || style.includes('heavy')) {
            styles.push('font-weight: 900;');
        }
        else if (style.includes('extrabold') || style.includes('extra bold')) {
            styles.push('font-weight: 800;');
        }
        else if (style.includes('semibold') || style.includes('semi bold') || style.includes('demi')) {
            styles.push('font-weight: 600;');
        }
        else if (style.includes('bold')) {
            styles.push('font-weight: 700;');
        }
        else if (style.includes('medium')) {
            styles.push('font-weight: 500;');
        }
        else if (style.includes('regular') || style === 'normal') {
            styles.push('font-weight: 400;');
        }
        else if (style.includes('extralight') || style.includes('extra light') || style.includes('ultra light')) {
            styles.push('font-weight: 200;');
        }
        else if (style.includes('light')) {
            styles.push('font-weight: 300;');
        }
        else if (style.includes('thin') || style.includes('hairline')) {
            styles.push('font-weight: 100;');
        }
        styles.push('font-style: normal;');
        if (style.includes('italic')) {
            styles.push('font-style: italic;');
        }
    }
    // Font size
    if (resolvedFontSize !== null) {
        styles.push(`font-size: ${resolvedFontSize}px;`);
    }
    // Line height
    if (resolvedLineHeight) {
        if (resolvedLineHeight.unit === 'PIXELS') {
            styles.push(`line-height: ${resolvedLineHeight.value}px;`);
        }
        else if (resolvedLineHeight.unit === 'PERCENT') {
            styles.push(`line-height: ${resolvedLineHeight.value}%;`);
        }
    }
    // Letter spacing
    if (resolvedLetterSpacing) {
        if (resolvedLetterSpacing.unit === 'PIXELS') {
            styles.push(`letter-spacing: ${resolvedLetterSpacing.value}px;`);
        }
        else if (resolvedLetterSpacing.unit === 'PERCENT') {
            styles.push(`letter-spacing: ${resolvedLetterSpacing.value / 100}em;`);
        }
    }
    // Text alignment
    if (node.textAlignHorizontal && typeof node.textAlignHorizontal === 'string') {
        const alignMap = {
            'LEFT': 'left',
            'CENTER': 'center',
            'RIGHT': 'right',
            'JUSTIFIED': 'justify'
        };
        styles.push(`text-align: ${alignMap[node.textAlignHorizontal] || 'left'};`);
    }
    // Paragraph indent -> CSS text-indent (used for bullet-style layouts)
    if ('paragraphIndent' in node && typeof node.paragraphIndent === 'number') {
        const indent = node.paragraphIndent;
        if (Math.abs(indent) > 0.001) {
            styles.push(`text-indent: ${indent}px;`);
        }
    }
    // Text color (from fills)
    if (node.fills && Array.isArray(node.fills)) {
        for (const fill of node.fills) {
            if (fill.visible === false)
                continue;
            if (fill.type === 'SOLID') {
                const opacity = fill.opacity !== undefined ? fill.opacity : 1;
                styles.push(`color: ${figmaColorToCss(fill.color, opacity)};`);
                break;
            }
        }
    }
    // Only add flex alignment for single-line text that needs vertical centering.
    // Multi-line or wrapping text should not use display:flex as it can interfere with wrapping.
    const fs = (typeof node.fontSize === 'number') ? node.fontSize : 16;
    const isSingleLine = !node.characters.includes('\n') && node.height <= (fs + 10);
    const isHidden = 'visible' in node && !node.visible;
    if (isSingleLine && !isHidden) {
        styles.push('display: flex;');
        styles.push('align-items: center;');
        // When using flex, text-align no longer works for horizontal alignment.
        // Map text alignment to justify-content instead.
        if (node.textAlignHorizontal === 'CENTER') {
            styles.push('justify-content: center;');
        }
        else if (node.textAlignHorizontal === 'RIGHT') {
            styles.push('justify-content: flex-end;');
        }
    }
    return styles;
}
function multiplyTransform(a, b) {
    return [
        [
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
            a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
        ],
        [
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
            a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
        ],
    ];
}
function invertTransform(t) {
    const a = t[0][0];
    const c = t[0][1];
    const e = t[0][2];
    const b = t[1][0];
    const d = t[1][1];
    const f = t[1][2];
    const det = a * d - b * c;
    if (!isFinite(det) || Math.abs(det) < 1e-12)
        return null;
    const invDet = 1 / det;
    return [
        [d * invDet, -c * invDet, (c * f - d * e) * invDet],
        [-b * invDet, a * invDet, (b * e - a * f) * invDet],
    ];
}
function getAbsoluteBounds(node) {
    if (!node)
        return null;
    const rb = node.absoluteRenderBounds;
    if (rb && isFinite(rb.x) && isFinite(rb.y) && isFinite(rb.width) && isFinite(rb.height)) {
        return rb;
    }
    const bb = node.absoluteBoundingBox;
    if (bb && isFinite(bb.x) && isFinite(bb.y) && isFinite(bb.width) && isFinite(bb.height)) {
        return bb;
    }
    const t = node.absoluteTransform;
    const w = typeof node.width === 'number' ? node.width : undefined;
    const h = typeof node.height === 'number' ? node.height : undefined;
    if (t && typeof w === 'number' && typeof h === 'number') {
        return { x: t[0][2], y: t[1][2], width: w, height: h };
    }
    return null;
}
function getAbsoluteBoundingBox(node) {
    if (!node)
        return null;
    const bb = node.absoluteBoundingBox;
    if (bb && isFinite(bb.x) && isFinite(bb.y) && isFinite(bb.width) && isFinite(bb.height)) {
        return bb;
    }
    return getAbsoluteBounds(node);
}
function getBoundsDelta(node) {
    const rb = node === null || node === void 0 ? void 0 : node.absoluteRenderBounds;
    const bb = node === null || node === void 0 ? void 0 : node.absoluteBoundingBox;
    if (!rb || !bb)
        return null;
    if (![rb.x, rb.y, bb.x, bb.y].every((v) => isFinite(v)))
        return null;
    return { dx: bb.x - rb.x, dy: bb.y - rb.y };
}
function getLocalXYFromRenderBoundsWithParentTransform(node, parent) {
    const rb = node === null || node === void 0 ? void 0 : node.absoluteRenderBounds;
    const pt = parent === null || parent === void 0 ? void 0 : parent.absoluteTransform;
    if (!rb || !pt)
        return null;
    const px = pt[0][2];
    const py = pt[1][2];
    if (![rb.x, rb.y, px, py].every((v) => isFinite(v)))
        return null;
    return { x: rb.x - px, y: rb.y - py };
}
function getLocalXYFromAbsoluteBounds(node, parent) {
    const nodeB = getAbsoluteBounds(node);
    const parentB = getAbsoluteBounds(parent);
    if (!nodeB || !parentB)
        return null;
    return { x: nodeB.x - parentB.x, y: nodeB.y - parentB.y };
}
function getLocalXYFromAbsoluteBoundingBox(node, parent) {
    const nodeB = getAbsoluteBoundingBox(node);
    const parentB = getAbsoluteBoundingBox(parent);
    if (!nodeB || !parentB)
        return null;
    return { x: nodeB.x - parentB.x, y: nodeB.y - parentB.y };
}
function getRotatedAnchorFromBoundingBoxes(node, parent) {
    if (!parent || !('width' in node) || !('height' in node))
        return null;
    const nodeB = getAbsoluteBoundingBox(node) || getAbsoluteBounds(node);
    const parentB = getAbsoluteBoundingBox(parent) || getAbsoluteBounds(parent);
    if (!nodeB || !parentB)
        return null;
    const localBbX = nodeB.x - parentB.x;
    const localBbY = nodeB.y - parentB.y;
    const centerX = localBbX + nodeB.width / 2;
    const centerY = localBbY + nodeB.height / 2;
    return {
        x: centerX - (node.width / 2),
        y: centerY - (node.height / 2),
    };
}
function getLocalXY(node, parent) {
    // In the Figma plugin API, children of GROUP nodes often have x/y in the coordinate space of
    // the group's parent, not the group itself. CONNECTOR nodes also need transform-based
    // calculation since their x/y may not be relative to the immediate parent.
    // Since we wrap GROUPs in their own <div>, we must convert to the group's local coordinate system.
    const needsTransformCalc = (parent && parent.type === 'GROUP') || node.type === 'CONNECTOR';
    // Rotated nodes need pre-rotation local coordinates when we emit CSS rotate() separately.
    // Use relative transforms first; this gives the unrotated local origin.
    const isRotated = 'rotation' in node && Math.abs(node.rotation || 0) > 0.001;
    if (isRotated && parent && node.type !== 'CONNECTOR') {
        const nodeT = node.absoluteTransform;
        const parentT = parent.absoluteTransform;
        if (nodeT && parentT) {
            const inv = invertTransform(parentT);
            if (inv) {
                const rel = multiplyTransform(inv, nodeT);
                return { x: rel[0][2], y: rel[1][2] };
            }
        }
        // Fallback when transform data is unavailable.
        const bbResult = getLocalXYFromAbsoluteBoundingBox(node, parent) || getLocalXYFromAbsoluteBounds(node, parent);
        if (bbResult)
            return bbResult;
    }
    if (needsTransformCalc && parent) {
        // For rotated nodes in groups, transform-based coordinates are preferred.
        // If unavailable, use absolute bounds fallback.
        if (isRotated) {
            const bbResult = getLocalXYFromAbsoluteBoundingBox(node, parent) || getLocalXYFromAbsoluteBounds(node, parent);
            if (bbResult)
                return bbResult;
        }
        const nodeT = node.absoluteTransform;
        const parentT = parent.absoluteTransform;
        if (nodeT && parentT) {
            const inv = invertTransform(parentT);
            if (inv) {
                const rel = multiplyTransform(inv, nodeT);
                return { x: rel[0][2], y: rel[1][2] };
            }
        }
        // Fallback for GROUP parents
        if (parent.type === 'GROUP') {
            const parentX = typeof parent.x === 'number' ? parent.x : 0;
            const parentY = typeof parent.y === 'number' ? parent.y : 0;
            return { x: node.x - parentX, y: node.y - parentY };
        }
    }
    return { x: node.x, y: node.y };
}
// Get layout styles for auto-layout frames
function getLayoutStyles(node) {
    const styles = [];
    if (node.layoutMode && node.layoutMode !== 'NONE') {
        styles.push('display: flex;');
        styles.push(`flex-direction: ${node.layoutMode === 'HORIZONTAL' ? 'row' : 'column'};`);
        // Gap
        if (node.itemSpacing) {
            if (node.itemSpacing < 0) {
                // Negative gap: CSS flexbox gap doesn't support negative values.
                // Overlap is achieved via negative margins on children (applied in getPositionStyles).
            }
            else if (node.layoutWrap === 'WRAP' && node.primaryAxisAlignItems === 'SPACE_BETWEEN') {
                // For space-between wrapping containers, Figma determines line breaks based
                // on item sizes alone, then distributes space between items. CSS flex-wrap
                // counts column-gap in the overflow check, causing premature wrapping.
                // Omit column-gap and let space-between handle inline spacing naturally.
                const crossGap = ('counterAxisSpacing' in node && node.counterAxisSpacing) || node.itemSpacing;
                styles.push(`row-gap: ${crossGap}px;`);
            }
            else {
                styles.push(`gap: ${node.itemSpacing}px;`);
            }
        }
        // Padding - but only emit if it doesn't overflow the element's dimensions.
        // Figma stores large padding values internally when centering content in fixed-size frames,
        // but these shouldn't be exported as-is since they conflict with explicit width/height.
        const pt = node.paddingTop || 0;
        const pr = node.paddingRight || 0;
        const pb = node.paddingBottom || 0;
        const pl = node.paddingLeft || 0;
        const nodeWidth = 'width' in node ? node.width : 0;
        const nodeHeight = 'height' in node ? node.height : 0;
        const verticalPadding = pt + pb;
        const horizontalPadding = pl + pr;
        // Only emit padding when it leaves reasonable content space.
        // Figma sometimes stores large padding values for alignment that don't translate well to CSS.
        // If padding exceeds 75% of the dimension, skip it — flexbox alignment handles centering.
        const paddingFitsVertically = nodeHeight === 0 || verticalPadding <= nodeHeight * 0.75;
        const paddingFitsHorizontally = nodeWidth === 0 || horizontalPadding <= nodeWidth * 0.75;
        // Apply padding per-axis: keep horizontal even if vertical overflows, and vice versa
        const effectivePt = paddingFitsVertically ? pt : 0;
        const effectivePb = paddingFitsVertically ? pb : 0;
        const effectivePl = paddingFitsHorizontally ? pl : 0;
        const effectivePr = paddingFitsHorizontally ? pr : 0;
        if (effectivePt || effectivePr || effectivePb || effectivePl) {
            styles.push(`padding: ${effectivePt}px ${effectivePr}px ${effectivePb}px ${effectivePl}px;`);
        }
        // Alignment
        const alignMap = {
            'MIN': 'flex-start',
            'CENTER': 'center',
            'MAX': 'flex-end',
            'SPACE_BETWEEN': 'space-between'
        };
        if (node.primaryAxisAlignItems) {
            styles.push(`justify-content: ${alignMap[node.primaryAxisAlignItems] || 'flex-start'};`);
        }
        if (node.counterAxisAlignItems) {
            styles.push(`align-items: ${alignMap[node.counterAxisAlignItems] || 'flex-start'};`);
        }
        // Wrap
        if (node.layoutWrap === 'WRAP') {
            styles.push('flex-wrap: wrap;');
        }
    }
    return styles;
}
// Get flex item styles for children of auto-layout
function getFlexItemStyles(node, parent) {
    const styles = [];
    if (parent && 'layoutMode' in parent && parent.layoutMode !== 'NONE') {
        const parentDir = parent.layoutMode; // 'HORIZONTAL' or 'VERTICAL'
        let hasGrow = false;
        // Check modern layoutSizing* properties first, then fall back to deprecated layoutGrow.
        // In Figma, FILL on the parent's main axis → flex-grow: 1
        const sizingH = 'layoutSizingHorizontal' in node ? node.layoutSizingHorizontal : null;
        const sizingV = 'layoutSizingVertical' in node ? node.layoutSizingVertical : null;
        let fillsMainAxis = (parentDir === 'HORIZONTAL' && sizingH === 'FILL') ||
            (parentDir === 'VERTICAL' && sizingV === 'FILL');
        // Heuristic FILL detection for instance/component nodes where layoutSizing*
        // properties may not propagate correctly from the main component.
        // If the sizing property is null (not just FIXED), check whether the node's
        // computed size closely matches the parent's content area on the main axis —
        // this strongly implies the node was set to FILL in the original component.
        if (!fillsMainAxis) {
            const mainSizing = parentDir === 'HORIZONTAL' ? sizingH : sizingV;
            if (mainSizing === null) {
                const parentW = 'width' in parent ? parent.width : 0;
                const parentH = 'height' in parent ? parent.height : 0;
                const pl = parent.paddingLeft || 0;
                const pr = parent.paddingRight || 0;
                const pt = parent.paddingTop || 0;
                const pb = parent.paddingBottom || 0;
                // Approximate content area along the main axis
                const contentMain = parentDir === 'HORIZONTAL'
                    ? parentW - pl - pr
                    : parentH - pt - pb;
                const nodeMain = parentDir === 'HORIZONTAL' ? node.width : node.height;
                // Allow generous tolerance — the node width may include border/stroke differences
                if (contentMain > 0 && nodeMain > 0 && Math.abs(nodeMain - contentMain) < contentMain * 0.15) {
                    fillsMainAxis = true;
                }
            }
        }
        if (fillsMainAxis) {
            styles.push('flex: 1 1 0px;');
            hasGrow = true;
        }
        else if ('layoutGrow' in node) {
            const layoutGrow = node.layoutGrow;
            if (layoutGrow && layoutGrow > 0) {
                styles.push(`flex: ${layoutGrow} 1 0px;`);
                hasGrow = true;
            }
        }
        if (!hasGrow) {
            // In wrapping flex containers, allow items to shrink slightly to account for
            // subpixel rounding differences between Figma and CSS.
            const parentWraps = 'layoutWrap' in parent && parent.layoutWrap === 'WRAP';
            styles.push(parentWraps ? 'flex: 0 1 auto;' : 'flex: none;');
        }
        // Check for align-self based on constraints — check modern FILL on cross-axis first
        let fillsCrossAxis = (parentDir === 'HORIZONTAL' && sizingV === 'FILL') ||
            (parentDir === 'VERTICAL' && sizingH === 'FILL');
        // Heuristic cross-axis FILL detection (same reasoning as main axis above)
        if (!fillsCrossAxis) {
            const crossSizing = parentDir === 'HORIZONTAL' ? sizingV : sizingH;
            if (crossSizing === null) {
                const parentW = 'width' in parent ? parent.width : 0;
                const parentH = 'height' in parent ? parent.height : 0;
                const pl = parent.paddingLeft || 0;
                const pr = parent.paddingRight || 0;
                const pt = parent.paddingTop || 0;
                const pb = parent.paddingBottom || 0;
                const contentCross = parentDir === 'HORIZONTAL'
                    ? parentH - pt - pb
                    : parentW - pl - pr;
                const nodeCross = parentDir === 'HORIZONTAL' ? node.height : node.width;
                if (contentCross > 0 && nodeCross > 0 && Math.abs(nodeCross - contentCross) < contentCross * 0.15) {
                    fillsCrossAxis = true;
                }
            }
        }
        if (fillsCrossAxis) {
            styles.push('align-self: stretch;');
        }
        else if ('layoutAlign' in node) {
            const layoutAlign = node.layoutAlign;
            if (layoutAlign === 'STRETCH') {
                styles.push('align-self: stretch;');
            }
        }
    }
    return styles;
}
// Check if a node is the first visible, non-absolute child in a flex parent.
// Used for negative itemSpacing: the first flex child should not get a negative margin.
function isFirstVisibleFlexChild(node, parent) {
    if (!('children' in parent))
        return true;
    const children = parent.children;
    for (const child of children) {
        if ('visible' in child && !child.visible)
            continue;
        if (isAbsolutePositioned(child, parent))
            continue;
        return child.id === node.id;
    }
    return true;
}
// Check if a node is a variant component (direct child of a COMPONENT_SET)
function isVariantComponent(node) {
    return node.type === 'COMPONENT' && node.parent !== null && node.parent.type === 'COMPONENT_SET';
}
// Check if a child is absolutely positioned within a flex parent
function isAbsolutePositioned(node, parent) {
    if (!parent || !('layoutMode' in parent))
        return true;
    if (parent.layoutMode === 'NONE')
        return true;
    // Connectors are always absolute (they don't participate in auto-layout flow)
    if (node.type === 'CONNECTOR')
        return true;
    // Check if the node has absolute positioning constraints
    if ('layoutPositioning' in node) {
        return node.layoutPositioning === 'ABSOLUTE';
    }
    return false;
}
// Get positioning styles
function getPositionStyles(node, parent, isRoot, siblingIndex = 0) {
    const styles = [];
    const transformParts = [];
    const parentFrame = parent;
    const isInAutoLayout = parentFrame && 'layoutMode' in parentFrame && parentFrame.layoutMode !== 'NONE';
    const isAbsolute = isAbsolutePositioned(node, parent);
    const isRotatedNode = 'rotation' in node && Math.abs(node.rotation || 0) > 0.001;
    if (isRoot) {
        styles.push('position: relative;');
    }
    else if (isInAutoLayout && !isAbsolute) {
        // Child of auto-layout - add flex item styles
        // Check if this node has absolute children (needs position:relative for them)
        if ('children' in node && node.children) {
            const hasAbsoluteChildren = node.children.some((child) => child.visible !== false && isAbsolutePositioned(child, node));
            if (hasAbsoluteChildren) {
                styles.push('position: relative;');
            }
        }
        // Check if parent has absolute children (siblings of this node)
        // If so, this flex child needs position:relative and z-index to stack above absolute siblings
        if (parentFrame && 'children' in parentFrame && parentFrame.children) {
            const parentHasAbsoluteChildren = parentFrame.children.some((child) => child.visible !== false && isAbsolutePositioned(child, parentFrame));
            if (parentHasAbsoluteChildren) {
                // Only add position:relative if not already added above
                if (!('children' in node && node.children &&
                    node.children.some((child) => child.visible !== false && isAbsolutePositioned(child, node)))) {
                    styles.push('position: relative;');
                }
                styles.push(`z-index: ${siblingIndex};`);
            }
        }
        styles.push(...getFlexItemStyles(node, parent));
        // Handle negative itemSpacing from parent — CSS gap doesn't support negative values.
        // Apply negative margin on the main axis for non-first flex children to create overlap.
        if (parentFrame && 'itemSpacing' in parentFrame && parentFrame.itemSpacing < 0) {
            const spacing = parentFrame.itemSpacing; // negative number
            const parentDir = parentFrame.layoutMode;
            if (!isFirstVisibleFlexChild(node, parentFrame)) {
                if (parentDir === 'VERTICAL') {
                    styles.push(`margin-top: ${spacing}px;`);
                }
                else {
                    styles.push(`margin-left: ${spacing}px;`);
                }
            }
        }
    }
    else {
        // Absolute positioning
        styles.push('position: absolute;');
        // Add z-index based on sibling order to ensure proper stacking
        // (later children in Figma appear on top of earlier ones)
        styles.push(`z-index: ${siblingIndex};`);
        // FigJam CONNECTOR nodes are especially sensitive to coordinate spaces and bounds.
        // Their x/y and width/height can differ from the actual rendered SVG extents.
        // Use absoluteRenderBounds/absoluteBoundingBox relative to the parent to position them.
        // For connectors, use render bounds relative to parent transform (more stable than parent bounds).
        // Then compensate for padding via translate between render bounds and bounding box.
        const connectorXY = node.type === 'CONNECTOR' && parent
            ? (getLocalXYFromRenderBoundsWithParentTransform(node, parent) || getLocalXYFromAbsoluteBounds(node, parent))
            : null;
        const rotatedAnchorXY = (isRotatedNode && node.type !== 'CONNECTOR')
            ? getRotatedAnchorFromBoundingBoxes(node, parent)
            : null;
        const { x: localX, y: localY } = connectorXY || rotatedAnchorXY || getLocalXY(node, parent);
        if (node.type === 'CONNECTOR') {
            // Avoid right/bottom heuristics for connectors; always anchor from top-left.
            // Keep subpixel precision to avoid visible gaps where multiple connector segments meet.
            styles.push(`left: ${localX.toFixed(2)}px;`);
            styles.push(`top: ${localY.toFixed(2)}px;`);
            const delta = getBoundsDelta(node);
            if (delta && (Math.abs(delta.dx) > 0.01 || Math.abs(delta.dy) > 0.01)) {
                transformParts.push(`translate(${delta.dx.toFixed(2)}px, ${delta.dy.toFixed(2)}px)`);
            }
        }
        else {
            // Check if this is a background element that fills the parent (use percentages like Figma does)
            const isBackgroundFill = parentFrame &&
                'width' in parentFrame &&
                'height' in parentFrame &&
                Math.abs(localX) <= 1 &&
                Math.abs(localY) <= 1 &&
                Math.abs(node.width - parentFrame.width) <= 1 &&
                Math.abs(node.height - parentFrame.height) <= 1;
            if (isBackgroundFill) {
                // Use percentage positioning to match Figma's export
                styles.push('left: 0.00%;');
                styles.push('right: 0.00%;');
                styles.push('top: 0.00%;');
                styles.push('bottom: 0.00%;');
            }
            else if (isRotatedNode) {
                // For rotated nodes, right/bottom heuristics can flip anchoring and create drift.
                // Keep explicit top-left anchoring with subpixel precision.
                styles.push(`left: ${localX.toFixed(2)}px;`);
                styles.push(`top: ${localY.toFixed(2)}px;`);
            }
            else if (parentFrame && 'width' in parentFrame && 'height' in parentFrame) {
                // Calculate if we should use right/bottom instead of left/top
                const parentWidth = parentFrame.width;
                const parentHeight = parentFrame.height;
                // Check if node is closer to right edge
                const distFromRight = parentWidth - (localX + node.width);
                const distFromLeft = localX;
                // Check if node is closer to bottom edge
                const distFromBottom = parentHeight - (localY + node.height);
                const distFromTop = localY;
                // Use right positioning if closer to right
                if (distFromRight < distFromLeft && distFromRight >= 0) {
                    styles.push(`right: ${Math.round(distFromRight)}px;`);
                }
                else {
                    styles.push(`left: ${Math.round(localX)}px;`);
                }
                // Use vertical centering if appropriate, otherwise top/bottom
                const isCenteredVertically = Math.abs((parentHeight - node.height) / 2 - localY) < 2;
                if (isCenteredVertically && node.height < parentHeight) {
                    styles.push(`top: calc(50% - ${node.height}px/2);`);
                }
                else if (distFromBottom < distFromTop && distFromBottom >= 0) {
                    styles.push(`bottom: ${Math.round(distFromBottom)}px;`);
                }
                else {
                    styles.push(`top: ${Math.round(localY)}px;`);
                }
            }
            else {
                const { x: localX, y: localY } = getLocalXY(node, parent);
                styles.push(`left: ${Math.round(localX)}px;`);
                styles.push(`top: ${Math.round(localY)}px;`);
            }
        }
    }
    // Dimensions - handle based on sizing mode like Figma's export
    if ('width' in node && 'height' in node) {
        const boundsOverride = node.type === 'CONNECTOR' ? getAbsoluteBounds(node) : null;
        const effectiveWidth = boundsOverride ? boundsOverride.width : node.width;
        const effectiveHeight = boundsOverride ? boundsOverride.height : node.height;
        const isAutoLayoutFrame = 'layoutMode' in node && node.layoutMode !== 'NONE';
        const primarySizing = isAutoLayoutFrame && 'primaryAxisSizingMode' in node ? node.primaryAxisSizingMode : null;
        const counterSizing = isAutoLayoutFrame && 'counterAxisSizingMode' in node ? node.counterAxisSizingMode : null;
        if (isRoot) {
            // Root element uses frame sizing modes when available
            const widthIsFixed = counterSizing ? counterSizing === 'FIXED' : ('layoutSizingHorizontal' in node ? node.layoutSizingHorizontal === 'FIXED' : true);
            const heightIsFixed = primarySizing ? primarySizing === 'FIXED' : ('layoutSizingVertical' in node ? node.layoutSizingVertical === 'FIXED' : true);
            styles.push(widthIsFixed ? `width: ${Math.round(effectiveWidth)}px;` : 'width: 100%;');
            styles.push(heightIsFixed ? `height: ${Math.round(effectiveHeight)}px;` : 'height: 100%;');
        }
        else if (isInAutoLayout && !isAbsolute) {
            // Check child sizing mode to determine whether to emit fixed dimensions.
            // When a node uses HUG sizing, omitting the fixed dimension lets CSS compute
            // it from its children (hidden nodes are excluded from the output entirely).
            const sizingH = 'layoutSizingHorizontal' in node ? node.layoutSizingHorizontal : null;
            const sizingV = 'layoutSizingVertical' in node ? node.layoutSizingVertical : null;
            // Determine HUG: only trust explicit layoutSizing* properties.
            // Do NOT fall back to the frame's own primaryAxisSizingMode/counterAxisSizingMode —
            // those describe how the frame sizes itself internally, not how it sizes in the parent layout.
            const isHugWidth = sizingH === 'HUG';
            const isHugHeight = sizingV === 'HUG';
            // Heuristic FILL detection for instance nodes where layoutSizing* may be null.
            // Must match the same logic used in getFlexItemStyles to stay consistent.
            const parentFrame2 = parent;
            const parentDir2 = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.layoutMode) || 'VERTICAL';
            let heuristicFillW = false;
            let heuristicFillH = false;
            if (sizingH === null || sizingV === null) {
                const pw = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.width) || 0;
                const ph = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.height) || 0;
                const ppl = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.paddingLeft) || 0;
                const ppr = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.paddingRight) || 0;
                const ppt = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.paddingTop) || 0;
                const ppb = (parentFrame2 === null || parentFrame2 === void 0 ? void 0 : parentFrame2.paddingBottom) || 0;
                if (sizingH === null) {
                    const contentW = pw - ppl - ppr;
                    if (contentW > 0 && effectiveWidth > 0 && Math.abs(effectiveWidth - contentW) < contentW * 0.15) {
                        // Main axis or cross axis — if this axis is FILL, omit the fixed width
                        if (parentDir2 === 'HORIZONTAL')
                            heuristicFillW = true; // main-axis FILL → flex handles it
                        else
                            heuristicFillW = true; // cross-axis FILL → align-self:stretch handles it
                    }
                }
                if (sizingV === null) {
                    const contentH = ph - ppt - ppb;
                    if (contentH > 0 && effectiveHeight > 0 && Math.abs(effectiveHeight - contentH) < contentH * 0.15) {
                        if (parentDir2 === 'VERTICAL')
                            heuristicFillH = true;
                        else
                            heuristicFillH = true;
                    }
                }
            }
            // Width: omit for HUG (CSS computes from children) and FILL (flex handles it)
            if (isHugWidth || sizingH === 'FILL' || heuristicFillW) {
                // Let CSS flex compute width
            }
            else {
                styles.push(`width: ${Math.round(effectiveWidth)}px;`);
            }
            // Height: omit for HUG (CSS computes from children) and FILL (flex handles it)
            if (isHugHeight || sizingV === 'FILL' || heuristicFillH) {
                // Let CSS flex compute height
            }
            else {
                styles.push(`height: ${Math.round(effectiveHeight)}px;`);
            }
        }
        else {
            // Absolute positioned or non-auto-layout: always add dimensions
            if (isAbsolute && isRotatedNode) {
                styles.push(`width: ${effectiveWidth.toFixed(2)}px;`);
                styles.push(`height: ${effectiveHeight.toFixed(2)}px;`);
            }
            else {
                styles.push(`width: ${Math.round(effectiveWidth)}px;`);
                styles.push(`height: ${Math.round(effectiveHeight)}px;`);
            }
        }
    }
    // Opacity
    if ('opacity' in node && typeof node.opacity === 'number' && node.opacity < 1) {
        styles.push(`opacity: ${node.opacity.toFixed(2)};`);
    }
    // Rotation (combine with any connector translate)
    if ('rotation' in node && node.rotation !== 0) {
        transformParts.push(`rotate(${-node.rotation}deg)`);
    }
    if (transformParts.length > 0) {
        styles.push(`transform: ${transformParts.join(' ')};`);
    }
    return styles;
}
// CSS storage
const cssRules = new Map();
const imageAssets = new Map();
// Images are always collected during export; the UI handles download separately.
let imageFolder = 'images';
function findVisibleImageFill(node) {
    if (!('fills' in node) || !node.fills || !Array.isArray(node.fills))
        return null;
    for (const fill of node.fills) {
        if (!fill || fill.visible === false)
            continue;
        if (fill.type === 'IMAGE')
            return fill;
    }
    return null;
}
async function ensureImageAsset(node) {
    const key = String(node.id || '0');
    const existing = imageAssets.get(key);
    if (existing)
        return existing;
    const safeId = key.replace(/[:;]/g, '-');
    const filename = `image-${safeId}.png`;
    const bytes = await node.exportAsync({ format: 'PNG' });
    const base64 = figma.base64Encode(bytes);
    const asset = { name: filename, mime: 'image/png', data: base64 };
    imageAssets.set(key, asset);
    return asset;
}
// Check whether an IMAGE fill has real bitmap data by actually reading the bytes.
// figma.getImageByHash() returns non-null for almost all hashes, so we must
// verify the image can actually deliver bytes.
async function imageFillHasData(fill) {
    if (!fill || !fill.imageHash)
        return false;
    try {
        const img = figma.getImageByHash(fill.imageHash);
        if (!img)
            return false;
        const bytes = await img.getBytesAsync();
        // A real image will have substantial data; a missing/broken one won't
        return bytes != null && bytes.length > 100;
    }
    catch (_) {
        return false;
    }
}
// Get the image source URL for a node with an image fill.
// Returns the exported PNG filename only when the fill has real bitmap data.
// Otherwise returns a placehold.co URL so we don't generate dozens of empty PNGs.
async function getImageSource(node) {
    const imageFill = findVisibleImageFill(node);
    if (!imageFill)
        return null;
    const w = Math.round(('width' in node ? node.width : 0) || 100);
    const h = Math.round(('height' in node ? node.height : 0) || 100);
    const placeholderUrl = `https://placehold.co/${w}x${h}`;
    // Only export if the image fill actually has retrievable bitmap data
    const hasData = await imageFillHasData(imageFill);
    if (!hasData) {
        return placeholderUrl;
    }
    try {
        const asset = await ensureImageAsset(node);
        if (asset.data) {
            return `${imageFolder}/${asset.name}`;
        }
    }
    catch (_) {
        // Export failed - fall back to placeholder
    }
    return placeholderUrl;
}
// Check if a node name suggests it is an image element.
// Background-like nodes (e.g. "image-bg", "bg") are excluded — they're decorative, not placeholders.
function looksLikeImageNode(node) {
    if (!node || !node.name)
        return false;
    const name = String(node.name).toLowerCase().trim();
    // Exclude background-like layer names — these are decorative fills, not image placeholders
    if (nodeNameLooksLikeBackground(name))
        return false;
    return name === 'image' || name.startsWith('image ') || name.startsWith('image-') ||
        name === 'img' || name === 'photo' || name === 'thumbnail' ||
        name === 'placeholder' || name.startsWith('image_') ||
        name === 'image placeholder' || name === 'image-placeholder';
}
// Get a placehold.co URL for a node's dimensions
function getPlaceholderUrl(node) {
    const w = Math.round(('width' in node ? node.width : 0) || 100);
    const h = Math.round(('height' in node ? node.height : 0) || 100);
    return `https://placehold.co/${w}x${h}`;
}
async function maybeAddImageFillStyles(node, styles) {
    const src = await getImageSource(node);
    if (!src)
        return;
    styles.push(`background-image: url('${src}');`);
    styles.push('background-repeat: no-repeat;');
    styles.push('background-position: center;');
    styles.push('background-size: cover;');
}
// Export node as SVG string (used internally)
async function exportNodeAsSvgString(node) {
    try {
        const svgBytes = await node.exportAsync({ format: 'SVG' });
        const svgString = String.fromCharCode.apply(null, Array.from(svgBytes));
        return svgString;
    }
    catch (e) {
        return null;
    }
}
// Export node as an SVG asset file (parallel to ensureImageAsset for PNGs).
// Returns the asset path relative to imageFolder, or null on failure.
async function ensureSvgAsset(node) {
    const key = 'svg-' + String(node.id || '0');
    const existing = imageAssets.get(key);
    if (existing)
        return `${imageFolder}/${existing.name}`;
    const svgString = await exportNodeAsSvgString(node);
    if (!svgString)
        return null;
    const safeId = String(node.id || '0').replace(/[:;]/g, '-');
    const filename = `icon-${safeId}.svg`;
    // Base64-encode the SVG so the download pipeline handles it identically to PNGs
    const base64 = figma.base64Encode(new Uint8Array(Array.from(svgString).map(c => c.charCodeAt(0))));
    const asset = { name: filename, mime: 'image/svg+xml', data: base64 };
    imageAssets.set(key, asset);
    return `${imageFolder}/${filename}`;
}
function getShapeWithTextTextLayer(node) {
    if (!node)
        return null;
    const t = node.text;
    if (!t)
        return null;
    // In FigJam/Plugin API variants, `text` can be a TextNode-like object or a lightweight object.
    return t;
}
function getCharactersFromUnknownTextLayer(textLayer) {
    if (!textLayer)
        return '';
    if (typeof textLayer === 'string')
        return textLayer;
    const chars = textLayer.characters;
    if (typeof chars === 'string')
        return chars;
    const text = textLayer.text;
    if (typeof text === 'string')
        return text;
    return '';
}
function nodeNameLooksLikeBackground(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n)
        return false;
    if (n === 'bg' || n === 'background')
        return true;
    // Common layer naming patterns
    return n.startsWith('bg ') || n.startsWith('bg-') || n.includes('/bg') || n.includes(' background') ||
        n.endsWith('-bg') || n.endsWith(' bg') || n === 'image-bg' || n === 'image bg';
}
function rectangleHasVisibleAppearance(node) {
    const fills = (node && node.fills && Array.isArray(node.fills)) ? node.fills : [];
    const strokes = (node && node.strokes && Array.isArray(node.strokes)) ? node.strokes : [];
    const hasFill = fills.some((p) => p && p.visible !== false);
    const hasStroke = strokes.some((p) => p && p.visible !== false);
    const hasShadow = Array.isArray(node.effects) && node.effects.some((e) => e && e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'));
    return hasFill || hasStroke || hasShadow;
}
function isHoistableBackgroundRectangle(child, parent) {
    if (!child || child.type !== 'RECTANGLE')
        return false;
    if (!nodeNameLooksLikeBackground(child.name))
        return false;
    if (child.visible === false)
        return false;
    // Must roughly match parent bounds and start at (0,0) in parent space.
    const { x: localX, y: localY } = getLocalXY(child, parent);
    const sizeMatches = Math.abs(child.width - parent.width) <= 1 && Math.abs(child.height - parent.height) <= 1;
    const posMatches = Math.abs(localX) <= 1 && Math.abs(localY) <= 1;
    if (!sizeMatches || !posMatches)
        return false;
    // Ensure it's actually a visual background layer.
    return rectangleHasVisibleAppearance(child);
}
// Process a node and generate HTML
async function processNode(node, parent, isRoot = false, indent = '', siblingIndex = 0) {
    var _a, _b, _c, _d;
    const className = generateClassName(node.name, node.id);
    let styles = [];
    let html = '';
    // Box sizing for all elements
    styles.push('box-sizing: border-box;');
    // Position and size
    styles.push(...getPositionStyles(node, parent, isRoot, siblingIndex));
    // Dashed strokes with custom controls are exported as SVG for fidelity.
    if (shouldExportNodeAsSvgForStroke(node)) {
        const svgSrc = await ensureSvgAsset(node);
        if (svgSrc) {
            styles.push('display: block;');
            html = `${indent}<img class="${className}" src="${svgSrc}" />\n`;
            cssRules.set(className, styles);
            return html;
        }
    }
    // Check for image fill or image placeholder — used below for <img> tag output.
    // For non-leaf nodes (FRAME etc with children), image fills are added as background-image.
    const imageSrc = await getImageSource(node);
    const isImagePlaceholder = !imageSrc && looksLikeImageNode(node);
    const effectiveImageSrc = imageSrc || (isImagePlaceholder ? getPlaceholderUrl(node) : null);
    // For container nodes (FRAME/GROUP with children), add image fill as background-image.
    // Leaf nodes (RECTANGLE) will use <img> tags instead — handled in their branch below.
    if (imageSrc && node.type !== 'RECTANGLE') {
        styles.push(`background-image: url('${imageSrc}');`);
        styles.push('background-repeat: no-repeat;');
        styles.push('background-position: center;');
        styles.push('background-size: cover;');
    }
    // Handle different node types
    if (node.type === 'TEXT') {
        const textNode = node;
        try {
            styles.push(...getTextStyles(textNode));
        }
        catch (_textStyleErr) {
            // Fallback: still render text even if style extraction fails
        }
        try {
            styles.push(...getShadowStyles(node));
        }
        catch (_shadowErr) { /* ignore */ }
        // Ensure fonts are loaded before reading text
        try {
            await ensureFontsLoadedForTextNode(textNode);
        }
        catch (_fontErr) {
            // Font loading can fail for instance text nodes; continue anyway
        }
        // Escape HTML in text content
        const textContent = textNode.characters
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        html = `${indent}<span class="${className}">${textContent}</span>\n`;
        cssRules.set(className, styles);
    }
    else if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'LINE' || node.type === 'POLYGON' || node.type === 'STAR' || node.type === 'CONNECTOR') {
        // Check if this is a separator line (horizontal/vertical rule with ~0 height/width)
        const separatorInfo = isSeparatorLine(node);
        if (separatorInfo) {
            // Render as a CSS-styled div instead of SVG — an <img> with height:0 is invisible
            // and even a <div> with border-box + height:0 + border hides the stroke.
            // Use background-color for the line and set the 0-dimension to the stroke weight.
            styles.push(`background-color: ${separatorInfo.strokeColor};`);
            if (separatorInfo.direction === 'horizontal') {
                // Replace height: 0px with the stroke weight so the line is visible
                const heightIdx = styles.findIndex(s => s.startsWith('height:'));
                if (heightIdx >= 0) {
                    styles[heightIdx] = `height: ${separatorInfo.strokeWeight}px;`;
                }
                else {
                    styles.push(`height: ${separatorInfo.strokeWeight}px;`);
                }
            }
            else {
                // Vertical separator — fix the width
                const widthIdx = styles.findIndex(s => s.startsWith('width:'));
                if (widthIdx >= 0) {
                    styles[widthIdx] = `width: ${separatorInfo.strokeWeight}px;`;
                }
                else {
                    styles.push(`width: ${separatorInfo.strokeWeight}px;`);
                }
            }
            html = `${indent}<div class="${className}"></div>\n`;
            cssRules.set(className, styles);
        }
        else {
            // Export vector/shape elements as external SVG asset files
            const svgSrc = await ensureSvgAsset(node);
            if (svgSrc) {
                styles.push('display: block;');
                html = `${indent}<img class="${className}" src="${svgSrc}" />
`;
                cssRules.set(className, styles);
            }
            else {
                styles.push(...getFillStyles(node));
                styles.push(...getStrokeStyles(node));
                html = `${indent}<div class="${className}"></div>\n`;
                cssRules.set(className, styles);
            }
        }
    }
    else if (node.type === 'RECTANGLE') {
        if (effectiveImageSrc) {
            // Image element: use <img> tag with placehold.co or exported image
            styles.push('object-fit: cover;');
            styles.push('max-width: 100%;');
            styles.push(...getStrokeStyles(node));
            styles.push(...getCornerRadiusStyles(node));
            styles.push(...getShadowStyles(node));
            html = `${indent}<img class="${className}" src="${effectiveImageSrc}" />\n`;
        }
        else {
            styles.push(...getFillStyles(node));
            styles.push(...getStrokeStyles(node));
            styles.push(...getCornerRadiusStyles(node));
            styles.push(...getShadowStyles(node));
            html = `${indent}<div class="${className}"></div>\n`;
        }
        cssRules.set(className, styles);
    }
    else if (node.type === 'ELLIPSE') {
        styles.push(...getFillStyles(node));
        styles.push(...getStrokeStyles(node));
        styles.push('border-radius: 50%;');
        styles.push(...getShadowStyles(node));
        html = `${indent}<div class="${className}"></div>\n`;
        cssRules.set(className, styles);
    }
    else if (node.type === 'SHAPE_WITH_TEXT') {
        // FigJam shape with text (copied into Figma)
        const shapeNode = node;
        styles.push(...getFillStyles(node));
        styles.push(...getStrokeStyles(node));
        styles.push(...getCornerRadiusStyles(node));
        styles.push(...getShadowStyles(node));
        // Add layout styles for centering text
        styles.push('display: flex;');
        styles.push('align-items: center;');
        styles.push('justify-content: center;');
        // Generate text span if there's text content
        let textHtml = '';
        try {
            const textLayer = getShapeWithTextTextLayer(shapeNode);
            // Ensure fonts are loaded before reading text when possible
            try {
                if (textLayer && typeof textLayer.getStyledTextSegments === 'function') {
                    await ensureFontsLoadedForTextNode(textLayer);
                }
            }
            catch (_) {
                // Ignore font loading errors; we'll still export the text.
            }
            const textContent = getCharactersFromUnknownTextLayer(textLayer);
            if (textContent && textContent.trim()) {
                const textClassName = generateClassName(node.name + '-text', node.id + '-text');
                const textStyles = ['box-sizing: border-box;'];
                // Get text styles from the shape's text properties
                // Font family
                const fontName = (_a = textLayer === null || textLayer === void 0 ? void 0 : textLayer.fontName) !== null && _a !== void 0 ? _a : shapeNode.fontName;
                if (fontName && typeof fontName !== 'symbol' && typeof fontName === 'object') {
                    textStyles.push(`font-family: '${fontName.family}', sans-serif;`);
                    const style = String(fontName.style || '').toLowerCase();
                    if (style.includes('bold')) {
                        textStyles.push('font-weight: 700;');
                    }
                    else if (style.includes('semibold') || style.includes('semi bold')) {
                        textStyles.push('font-weight: 600;');
                    }
                    else if (style.includes('medium')) {
                        textStyles.push('font-weight: 500;');
                    }
                    else {
                        textStyles.push('font-weight: 400;');
                    }
                    if (style.includes('italic')) {
                        textStyles.push('font-style: italic;');
                    }
                }
                // Font size
                const fontSize = (_b = textLayer === null || textLayer === void 0 ? void 0 : textLayer.fontSize) !== null && _b !== void 0 ? _b : shapeNode.fontSize;
                if (typeof fontSize === 'number') {
                    textStyles.push(`font-size: ${fontSize}px;`);
                }
                // Text color from fills
                const fills = (_c = textLayer === null || textLayer === void 0 ? void 0 : textLayer.fills) !== null && _c !== void 0 ? _c : ((textLayer === null || textLayer === void 0 ? void 0 : textLayer.fills) !== undefined ? textLayer.fills : (_d = shapeNode.text) === null || _d === void 0 ? void 0 : _d.fills);
                if (fills && Array.isArray(fills)) {
                    for (const fill of fills) {
                        if (fill.visible === false)
                            continue;
                        if (fill.type === 'SOLID') {
                            const opacity = fill.opacity !== undefined ? fill.opacity : 1;
                            textStyles.push(`color: ${figmaColorToCss(fill.color, opacity)};`);
                            break;
                        }
                    }
                }
                textStyles.push('text-align: center;');
                textStyles.push('white-space: pre-wrap;');
                textStyles.push('display: block;');
                textStyles.push('width: 100%;');
                const escapedText = textContent
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                textHtml = `${indent}  <span class="${textClassName}">${escapedText}</span>\n`;
                cssRules.set(textClassName, textStyles);
            }
        }
        catch (e) {
            // If we can't load fonts or get text, just continue without text
        }
        html = `${indent}<div class="${className}">\n${textHtml}${indent}</div>\n`;
        cssRules.set(className, styles);
    }
    else if (node.type === 'FRAME' || node.type === 'GROUP' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE') {
        // Check if this is an icon that should be exported as SVG asset
        if (isIconNode(node)) {
            const svgSrc = await ensureSvgAsset(node);
            if (svgSrc) {
                styles.push('display: block;');
                html = `${indent}<img class="${className}" src="${svgSrc}" />\n`;
                cssRules.set(className, styles);
                return html;
            }
        }
        styles.push(...getFillStyles(node));
        styles.push(...getStrokeStyles(node));
        styles.push(...getCornerRadiusStyles(node));
        styles.push(...getShadowStyles(node));
        // Layout styles for frames with auto-layout
        if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE') {
            // COMPONENT_SET nodes have layoutMode NONE in Figma (freeform canvas),
            // but we still emit flex-column so the container has a display context.
            // Children are absolutely positioned so this flex doesn't affect their layout.
            if (node.type === 'COMPONENT_SET') {
                styles.push('display: flex;');
                styles.push('flex-direction: column;');
                styles.push('gap: 20px;');
            }
            else {
                // All other types (including variant components) use their real layout styles
                // so that padding, alignment, and gap from Figma are preserved.
                styles.push(...getLayoutStyles(node));
            }
            // Add isolation for elements with absolute children
            if ('children' in node) {
                const hasAbsoluteChildren = node.children.some((child) => child.visible !== false && isAbsolutePositioned(child, node));
                if (hasAbsoluteChildren) {
                    styles.push('isolation: isolate;');
                }
            }
        }
        // Clip content
        if ('clipsContent' in node && node.clipsContent) {
            styles.push('overflow: hidden;');
        }
        // If this container clips content and includes a BG/background-like child, ensure the
        // container keeps its designed size; otherwise the BG can be clipped.
        if ('clipsContent' in node && node.clipsContent && 'children' in node && node.children) {
            const hasBgLikeChild = node.children.some((child) => (child === null || child === void 0 ? void 0 : child.visible) !== false && nodeNameLooksLikeBackground(String((child === null || child === void 0 ? void 0 : child.name) || '')));
            if (hasBgLikeChild) {
                const hasWidth = styles.some(s => typeof s === 'string' && s.startsWith('width:'));
                const hasHeight = styles.some(s => typeof s === 'string' && s.startsWith('height:'));
                if (!hasWidth && typeof node.width === 'number') {
                    styles.push(`width: ${Math.round(node.width)}px;`);
                }
                if (!hasHeight && typeof node.height === 'number') {
                    styles.push(`height: ${Math.round(node.height)}px;`);
                }
            }
        }
        // If there is a full-size background rectangle child (often named BG/Background),
        // hoist its visual styles onto the container and skip exporting that child.
        const skipChildIds = new Set();
        if ('children' in node && node.children && node.children.length > 0) {
            const candidate = node.children.find((c) => isHoistableBackgroundRectangle(c, node));
            if (candidate) {
                const bgStyles = [];
                bgStyles.push(...getFillStyles(candidate));
                bgStyles.push(...getStrokeStyles(candidate));
                bgStyles.push(...getCornerRadiusStyles(candidate));
                bgStyles.push(...getShadowStyles(candidate));
                await maybeAddImageFillStyles(candidate, bgStyles);
                styles.push(...bgStyles);
                skipChildIds.add(candidate.id);
            }
        }
        // Process children
        let childrenHtml = '';
        if ('children' in node) {
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i];
                if (skipChildIds.has(child.id))
                    continue;
                // Skip hidden nodes — they should not appear in the exported HTML
                if ('visible' in child && !child.visible)
                    continue;
                const childHtml = await processNode(child, node, false, indent + '  ', i);
                childrenHtml += childHtml;
            }
        }
        html = `${indent}<div class="${className}">\n${childrenHtml}${indent}</div>\n`;
        cssRules.set(className, styles);
    }
    return html;
}
// Generate complete CSS from rules
function generateCss() {
    let css = `/* Generated by DanHTML (${EXPORTER_VERSION}) */\n\n`;
    css += `* {
  margin: 0;
  padding: 0;
}

`;
    for (const [className, styles] of cssRules) {
        if (styles.length > 0) {
            css += `.${className} {\n`;
            for (const style of styles) {
                css += `  ${style}\n`;
            }
            css += '}\n\n';
        }
    }
    return css;
}
// Main export function
async function exportToHtml(node) {
    cssRules.clear();
    imageAssets.clear();
    imageFolder = 'images';
    const bodyHtml = await processNode(node, null, true, '    ');
    const css = generateCss();
    // Collect unique font families referenced in the CSS to build a Google Fonts link.
    const fontFamilies = new Set();
    for (const styles of cssRules.values()) {
        for (const s of styles) {
            const match = s.match(/font-family:\s*'([^']+)'/);
            if (match)
                fontFamilies.add(match[1]);
        }
    }
    // Build Google Fonts <link> tag with a comprehensive weight range
    let googleFontsLink = '';
    if (fontFamilies.size > 0) {
        const families = Array.from(fontFamilies).map(f => {
            const encoded = f.replace(/ /g, '+');
            return `family=${encoded}:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900`;
        }).join('&');
        googleFontsLink = `\n  <link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  <link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet">`;
    }
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${node.name}</title>${googleFontsLink}
  <style>
${css.split('\n').map(line => '    ' + line).join('\n')}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
    return { html: fullHtml, css, assets: Array.from(imageAssets.values()) };
}
// Show UI
figma.showUI(__html__, { width: 600, height: 500 });
function sanitizeFileBaseName(name) {
    const trimmed = (name || '').trim();
    const safe = trimmed
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9._() -]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[_ .]+|[_ .]+$/g, '');
    return safe || 'component';
}
function sanitizeFolderName(name) {
    const trimmed = (name || '').trim();
    const safe = trimmed
        .replace(/[<>:"\\|?*]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .replace(/^[-. ]+|[-. ]+$/g, '');
    return safe || 'folder';
}
function splitHierarchy(name) {
    return String(name || '')
        .split('/')
        .map((p) => p.trim())
        .filter(Boolean);
}
function buildHtmlPathFromName(name) {
    const parts = splitHierarchy(name);
    const leafRaw = parts.length ? parts[parts.length - 1] : (name || 'component');
    const folders = parts.slice(0, -1).map(sanitizeFolderName);
    const fileBase = sanitizeFileBaseName(leafRaw);
    const rel = folders.length ? `${folders.join('/')}/${fileBase}.html` : `${fileBase}.html`;
    return rel;
}
function ensureUniqueFileName(base, used) {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    const dot = base.lastIndexOf('.');
    const stem = dot >= 0 ? base.slice(0, dot) : base;
    const ext = dot >= 0 ? base.slice(dot) : '';
    let i = 2;
    while (used.has(`${stem}-${i}${ext}`))
        i++;
    const next = `${stem}-${i}${ext}`;
    used.add(next);
    return next;
}
const PICKER_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);
function isOuterPageFrameOrComponent(node) {
    let parent = node.parent;
    while (parent && parent.type !== 'PAGE') {
        if (parent.type !== 'SECTION')
            return false;
        parent = parent.parent || null;
    }
    return true;
}
function collectOuterCandidates() {
    const all = figma.currentPage.findAll((n) => {
        if (!PICKER_TYPES.has(n.type))
            return false;
        if ('visible' in n && !n.visible)
            return false;
        return isOuterPageFrameOrComponent(n);
    });
    return all.sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0)
            return byName;
        return a.id.localeCompare(b.id);
    });
}
function buildPickerItems(nodes) {
    const items = [];
    for (const node of nodes) {
        if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET')
            continue;
        items.push({ id: node.id, name: node.name, type: node.type });
    }
    return items;
}
function resolvePickerSelection(nodeIds) {
    const byId = new Map();
    for (const node of collectOuterCandidates()) {
        byId.set(node.id, node);
    }
    const picked = [];
    const seen = new Set();
    for (const id of nodeIds) {
        if (seen.has(id))
            continue;
        seen.add(id);
        const node = byId.get(id);
        if (node)
            picked.push(node);
    }
    return picked;
}
async function handleExportWithFallback(nodeIds) {
    if (Array.isArray(nodeIds)) {
        const selectedNodes = resolvePickerSelection(nodeIds);
        if (selectedNodes.length === 0) {
            figma.ui.postMessage({ type: 'error', message: 'Please select at least one frame/component to export.' });
            return;
        }
        const previousSelection = [...figma.currentPage.selection];
        figma.currentPage.selection = selectedNodes;
        try {
            await handleExport();
        }
        finally {
            figma.currentPage.selection = previousSelection;
        }
        return;
    }
    const selection = figma.currentPage.selection;
    if (selection.length > 0) {
        await handleExport();
        return;
    }
    const candidates = collectOuterCandidates();
    if (candidates.length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'No outer frames/components found on this page.' });
        return;
    }
    const items = buildPickerItems(candidates);
    figma.ui.postMessage({
        type: 'selection-candidates',
        items,
        defaultSelectedIds: items.map((i) => i.id),
    });
}
// Check selection and export
async function handleExport() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'Please select a frame to export.' });
        return;
    }
    // Validate all selected nodes are exportable types
    const validTypes = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP']);
    for (const node of selection) {
        if (!validTypes.has(node.type)) {
            figma.ui.postMessage({ type: 'error', message: 'Please select only frames, components, component sets (variants), or groups to export.' });
            return;
        }
    }
    // Expand COMPONENT_SET nodes into their variant children
    const exportNodes = [];
    const exportNames = [];
    for (const node of selection) {
        if (node.type === 'COMPONENT_SET') {
            // Add each variant child with aggregated name
            for (const child of node.children) {
                if ('visible' in child && !child.visible)
                    continue;
                exportNodes.push(child);
                exportNames.push(`${node.name} - ${child.name}`);
            }
        }
        else {
            exportNodes.push(node);
            exportNames.push(node.name);
        }
    }
    if (exportNodes.length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'No exportable nodes found.' });
        return;
    }
    // Single node — send success
    if (exportNodes.length === 1) {
        const node = exportNodes[0];
        try {
            figma.ui.postMessage({ type: 'loading', message: 'Exporting design...' });
            const result = await exportToHtml(node);
            figma.ui.postMessage({ type: 'success', html: result.html, name: exportNames[0], assets: result.assets || [], version: EXPORTER_VERSION });
        }
        catch (error) {
            const msg = error instanceof Error ? `${error.message}\n\nStack:\n${error.stack}` : String(error);
            figma.ui.postMessage({ type: 'error', message: `Export failed: ${msg}` });
        }
        return;
    }
    // Multiple nodes — export one HTML per node
    try {
        figma.ui.postMessage({ type: 'loading', message: `Exporting ${exportNodes.length} items...` });
        const usedNames = new Set();
        const htmlFiles = [];
        const assetsByName = new Map();
        const errors = [];
        for (let i = 0; i < exportNodes.length; i++) {
            const node = exportNodes[i];
            const displayName = exportNames[i];
            figma.ui.postMessage({
                type: 'loading',
                message: `Exporting ${i + 1}/${exportNodes.length}: ${displayName}`,
            });
            const fileName = ensureUniqueFileName(`${sanitizeFileBaseName(displayName)}.html`, usedNames);
            try {
                const result = await exportToHtml(node);
                htmlFiles.push({ name: fileName, html: result.html });
                for (const asset of result.assets || []) {
                    if (!asset || !asset.name)
                        continue;
                    if (!assetsByName.has(asset.name))
                        assetsByName.set(asset.name, asset);
                }
            }
            catch (e) {
                const message = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
                errors.push({ component: displayName, id: node.id, message });
            }
        }
        figma.ui.postMessage({
            type: 'multi-success',
            count: htmlFiles.length,
            files: htmlFiles,
            assets: Array.from(assetsByName.values()),
            names: exportNames,
            errors,
            version: EXPORTER_VERSION,
        });
    }
    catch (error) {
        const msg = error instanceof Error ? `${error.message}\n\nStack:\n${error.stack}` : String(error);
        figma.ui.postMessage({ type: 'error', message: `Export failed: ${msg}` });
    }
}
async function handleExportAllComponents() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'Select a frame/component/group to export its components.' });
        return;
    }
    if (selection.length > 1) {
        figma.ui.postMessage({ type: 'error', message: 'Please select only one node to scope the component export.' });
        return;
    }
    const scope = selection[0];
    if (scope.type !== 'FRAME' && scope.type !== 'GROUP' && scope.type !== 'COMPONENT' && scope.type !== 'COMPONENT_SET' && scope.type !== 'INSTANCE') {
        figma.ui.postMessage({ type: 'error', message: 'Please select a frame, component, component set (variants), instance, or group to scope the component export.' });
        return;
    }
    // If the user selected a component or a component set, export the selected node itself.
    // This keeps all variants/children together in one HTML (no ZIP needed).
    if (scope.type === 'COMPONENT' || scope.type === 'COMPONENT_SET') {
        try {
            figma.ui.postMessage({ type: 'loading', message: `Exporting: ${scope.name}` });
            const result = await exportToHtml(scope);
            figma.ui.postMessage({ type: 'success', html: result.html, name: scope.name, assets: result.assets || [], version: EXPORTER_VERSION });
        }
        catch (error) {
            const msg = error instanceof Error ? `${error.message}\n\nStack:\n${error.stack}` : String(error);
            figma.ui.postMessage({ type: 'error', message: `Export failed: ${msg}` });
        }
        return;
    }
    const allInScope = ('findAll' in scope)
        ? scope.findAll((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE')
        : [];
    // Export units:
    // - Every COMPONENT_SET as a single HTML (all variants together)
    // - Every standalone COMPONENT that is not inside a COMPONENT_SET
    // - Every top-level INSTANCE (not nested inside another INSTANCE, and not inside a COMPONENT_SET/COMPONENT definition)
    const exportUnitsById = new Map();
    for (const n of allInScope) {
        if (n.type === 'COMPONENT_SET') {
            exportUnitsById.set(n.id, n);
            continue;
        }
        if (n.type === 'COMPONENT') {
            // Skip components that are variants within a component set (they'd be exported as part of the set)
            let p = n.parent;
            let inSet = false;
            while (p) {
                if (p.type === 'COMPONENT_SET') {
                    inSet = true;
                    break;
                }
                p = p.parent || null;
            }
            if (!inSet)
                exportUnitsById.set(n.id, n);
        }
        if (n.type === 'INSTANCE') {
            // Skip instances nested in a component definition or component set
            let p = n.parent;
            let skip = false;
            while (p) {
                const t = p.type;
                if (t === 'COMPONENT_SET' || t === 'COMPONENT') {
                    skip = true;
                    break;
                }
                // Only export top-level instances (avoid duplicating nested instances)
                if (t === 'INSTANCE') {
                    skip = true;
                    break;
                }
                p = p.parent || null;
            }
            if (!skip)
                exportUnitsById.set(n.id, n);
        }
    }
    const exportUnits = Array.from(exportUnitsById.values());
    if (exportUnits.length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'No components or component sets found within the selected node.' });
        return;
    }
    try {
        figma.ui.postMessage({ type: 'loading', message: `Exporting ${exportUnits.length} items from: ${scope.name}` });
        const usedNames = new Set();
        const htmlFiles = [];
        const assetsByName = new Map();
        // Sort for stable output
        const sorted = [...exportUnits].sort((a, b) => a.name.localeCompare(b.name));
        const errors = [];
        const perComponentTimeoutMs = 60000;
        const withTimeout = async (label, promise, ms) => {
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
            });
            try {
                return await Promise.race([promise, timeout]);
            }
            finally {
                try {
                    clearTimeout(timer);
                }
                catch (_) { }
            }
        };
        for (let i = 0; i < sorted.length; i++) {
            const component = sorted[i];
            figma.ui.postMessage({
                type: 'loading',
                message: `Exporting component ${i + 1}/${sorted.length}: ${component.name}`,
            });
            const fileName = ensureUniqueFileName(buildHtmlPathFromName(component.name), usedNames);
            try {
                const result = await withTimeout(`Export ${component.name}`, exportToHtml(component), perComponentTimeoutMs);
                htmlFiles.push({ name: fileName, html: result.html });
                for (const asset of result.assets || []) {
                    if (!asset || !asset.name)
                        continue;
                    if (!assetsByName.has(asset.name))
                        assetsByName.set(asset.name, asset);
                }
            }
            catch (e) {
                const message = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
                errors.push({ component: component.name, id: component.id, message });
                console.log(`Export failed for component ${component.name} (${component.id}): ${message}`);
            }
        }
        figma.ui.postMessage({
            type: 'components-success',
            count: htmlFiles.length,
            pageName: scope.name,
            files: htmlFiles,
            assets: Array.from(assetsByName.values()),
            errors,
        });
    }
    catch (error) {
        const msg = error instanceof Error ? `${error.message}\n\nStack:\n${error.stack}` : String(error);
        figma.ui.postMessage({ type: 'error', message: `Export components failed: ${msg}` });
    }
}
// Handle messages from UI
figma.ui.onmessage = (msg) => {
    if (msg.type === 'export') {
        handleExportWithFallback();
    }
    else if (msg.type === 'export-selected') {
        handleExportWithFallback(Array.isArray(msg.nodeIds) ? msg.nodeIds : []);
    }
    else if (msg.type === 'close') {
        figma.closePlugin();
    }
};
// Initial export on plugin start
handleExportWithFallback();
