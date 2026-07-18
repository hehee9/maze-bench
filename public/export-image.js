/**
 * @file public/export-image.js
 * @description Export dashboard visualizations as watermarked PNG images
 */

(function exposeImageExport(globalScope) {
  "use strict";

  const DEFAULT_EXPORT_WIDTH = 1680;
  const DEFAULT_PIXEL_RATIO = 2;
  const EXPORT_EVENT = "maze-bench:exportstatus";
  const COST_POINT_RADIUS = 7;
  const EXPORT_LABEL_GAP = 6;
  const EXPORT_LABEL_BOUNDARY_PADDING = 4;
  const EXPORT_LABEL_COLLISION_PADDING = 2;
  const EXPORT_LABEL_POINT_PADDING = 3;
  const EXPORT_LABEL_DEFAULT_ANGLE = -90;
  const EXPORT_LABEL_COARSE_STEP = 2;
  const EXPORT_LABEL_FINE_STEP = 0.1;
  const EXPORT_LABEL_FINE_RANGE = 2;
  const EXPORT_LABEL_MAX_PASSES = 3;

  /** @description Wait until browser layout has advanced by one frame */
  function _nextFrame() {
    return new Promise((resolve) => {
      globalScope.requestAnimationFrame?.(() => resolve());
    });
  }

  /** @description Convert arbitrary text to a safe PNG filename */
  function _sanitizeFilename(filename) {
    const base = String(filename || "maze-bench-export.png")
      .replace(/\.png$/i, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "");
    return `${base || "maze-bench-export"}.png`;
  }

  /** @description Publish a translated export status */
  function _setStatus(status, key) {
    const message = globalScope.MazeBenchI18n?.t(key) ?? key;
    let region = globalScope.document?.querySelector("[data-export-status]");
    if (!region && globalScope.document?.body) {
      region = globalScope.document.createElement("div");
      region.className = "export-status";
      region.dataset.exportStatus = "";
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      globalScope.document.body.append(region);
    }
    if (region) {
      region.textContent = message;
      region.dataset.status = status;
      region.hidden = false;
      globalScope.setTimeout?.(() => {
        region.hidden = true;
      }, status === "error" ? 5000 : 2400);
    }
    globalScope.dispatchEvent?.(new CustomEvent(EXPORT_EVENT, {
      detail: { status, message },
    }));
  }

  /** @description Load an image source and reject with a useful error */
  function _loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not render exported SVG"));
      image.src = source;
    });
  }

  /** @description Normalize an angle to the range from 0 through 360 degrees */
  function _normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
  }

  /** @description Return the smallest difference between two angles */
  function _getAngleDifference(first, second) {
    const difference = Math.abs(
      _normalizeAngle(first) - _normalizeAngle(second),
    );
    return Math.min(difference, 360 - difference);
  }

  /** @description Calculate the overlapping area of two label boxes */
  function _getBoxOverlapArea(first, second, padding = 0) {
    const overlapWidth = Math.max(
      0,
      Math.min(first.right + padding, second.right)
        - Math.max(first.left - padding, second.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(first.bottom + padding, second.bottom)
        - Math.max(first.top - padding, second.top),
    );
    return overlapWidth * overlapHeight;
  }

  /** @description Calculate how much of a label falls outside the chart */
  function _getBoundaryOverflowArea(box, bounds) {
    const boxArea = Math.max(0, box.right - box.left)
      * Math.max(0, box.bottom - box.top);
    const insideWidth = Math.max(
      0,
      Math.min(box.right, bounds.right) - Math.max(box.left, bounds.left),
    );
    const insideHeight = Math.max(
      0,
      Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top),
    );
    return Math.max(0, boxArea - insideWidth * insideHeight);
  }

  /** @description Measure the shortest distance from a point to a label box */
  function _getPointToLabelDistance(
    distance,
    cosine,
    sine,
    halfWidth,
    halfHeight,
  ) {
    const outsideX = Math.max(
      Math.abs(cosine * distance) - halfWidth,
      0,
    );
    const outsideY = Math.max(
      Math.abs(sine * distance) - halfHeight,
      0,
    );
    return Math.hypot(outsideX, outsideY);
  }

  /** @description Find the center distance that preserves the label gap */
  function _getFixedGapCenterDistance(angle, halfWidth, halfHeight) {
    const radians = angle * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const targetDistance = COST_POINT_RADIUS + EXPORT_LABEL_GAP;
    let low = 0;
    let high = halfWidth + halfHeight + targetDistance;

    while (
      _getPointToLabelDistance(
        high,
        cosine,
        sine,
        halfWidth,
        halfHeight,
      ) < targetDistance
    ) {
      high *= 2;
    }

    for (let iteration = 0; iteration < 24; iteration += 1) {
      const middle = (low + high) / 2;
      const distance = _getPointToLabelDistance(
        middle,
        cosine,
        sine,
        halfWidth,
        halfHeight,
      );
      if (distance < targetDistance) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return high;
  }

  /** @description Build the label position and box for one angle */
  function _getLabelPlacement(record, angle) {
    const halfWidth = record.width / 2;
    const halfHeight = record.height / 2;
    const radians = angle * Math.PI / 180;
    const distance = _getFixedGapCenterDistance(
      angle,
      halfWidth,
      halfHeight,
    );
    const centerX = record.pointX + Math.cos(radians) * distance;
    const centerY = record.pointY + Math.sin(radians) * distance;

    return {
      angle: _normalizeAngle(angle),
      x: centerX - record.anchorOffsetX,
      y: centerY - record.anchorOffsetY,
      box: {
        left: centerX - halfWidth,
        right: centerX + halfWidth,
        top: centerY - halfHeight,
        bottom: centerY + halfHeight,
      },
    };
  }

  /** @description Score one label position by boundary, collisions, and angle */
  function _getPlacementScore(record, placement, records, bounds) {
    let collisionOverlap = 0;

    for (const other of records) {
      if (other === record) {
        continue;
      }
      collisionOverlap += _getBoxOverlapArea(
        placement.box,
        other.placement.box,
        EXPORT_LABEL_COLLISION_PADDING,
      );
      const pointRadius = COST_POINT_RADIUS + EXPORT_LABEL_POINT_PADDING;
      collisionOverlap += _getBoxOverlapArea(placement.box, {
        left: other.pointX - pointRadius,
        right: other.pointX + pointRadius,
        top: other.pointY - pointRadius,
        bottom: other.pointY + pointRadius,
      });
    }

    return {
      boundaryOverflow: _getBoundaryOverflowArea(placement.box, bounds),
      collisionOverlap,
      angleDistance: _getAngleDifference(
        placement.angle,
        EXPORT_LABEL_DEFAULT_ANGLE,
      ),
      angleOrder: placement.angle,
    };
  }

  /** @description Compare label scores in their priority order */
  function _comparePlacementScores(first, second) {
    for (const key of [
      "boundaryOverflow",
      "collisionOverlap",
      "angleDistance",
      "angleOrder",
    ]) {
      const difference = first[key] - second[key];
      if (Math.abs(difference) > 0.0001) {
        return difference;
      }
    }
    return 0;
  }

  /** @description Search the full circle for the best label position */
  function _findBestLabelPlacement(record, records, bounds) {
    let bestPlacement = null;
    let bestScore = null;

    for (let angle = 0; angle < 360; angle += EXPORT_LABEL_COARSE_STEP) {
      const placement = _getLabelPlacement(record, angle);
      const score = _getPlacementScore(record, placement, records, bounds);
      if (!bestScore || _comparePlacementScores(score, bestScore) < 0) {
        bestPlacement = placement;
        bestScore = score;
      }
    }

    const fineSteps = Math.round(
      EXPORT_LABEL_FINE_RANGE / EXPORT_LABEL_FINE_STEP,
    );
    for (let step = -fineSteps; step <= fineSteps; step += 1) {
      const angle = bestPlacement.angle + step * EXPORT_LABEL_FINE_STEP;
      const placement = _getLabelPlacement(record, angle);
      const score = _getPlacementScore(record, placement, records, bounds);
      if (_comparePlacementScores(score, bestScore) < 0) {
        bestPlacement = placement;
        bestScore = score;
      }
    }
    return bestPlacement;
  }

  /** @description Count nearby points so crowded labels are placed first */
  function _getLabelDensity(record, records) {
    return records.reduce((density, other) => {
      if (other === record) {
        return density;
      }
      const distance = Math.hypot(
        record.pointX - other.pointX,
        record.pointY - other.pointY,
      );
      const threshold = Math.max(record.width, other.width) / 2 + 48;
      return density + (distance < threshold ? 1 : 0);
    }, 0);
  }

  /** @description Place cost-scatter labels for the exported image */
  function _prepareCostScatterLabels(root) {
    const labelElements = [
      ...root.querySelectorAll("[data-cost-scatter-label='true']"),
    ];
    if (!labelElements.length) {
      return undefined;
    }

    const svg = labelElements[0].closest("svg");
    const viewBox = svg?.viewBox?.baseVal;
    const width = viewBox?.width || svg?.width?.baseVal?.value;
    const height = viewBox?.height || svg?.height?.baseVal?.value;
    if (!svg || !width || !height) {
      return undefined;
    }

    const bounds = {
      left: (viewBox?.x || 0) + EXPORT_LABEL_BOUNDARY_PADDING,
      right: (viewBox?.x || 0) + width - EXPORT_LABEL_BOUNDARY_PADDING,
      top: (viewBox?.y || 0) + EXPORT_LABEL_BOUNDARY_PADDING,
      bottom: (viewBox?.y || 0) + height - EXPORT_LABEL_BOUNDARY_PADDING,
    };
    const originalPositions = labelElements.map((element) => ({
      element,
      x: element.getAttribute("x"),
      y: element.getAttribute("y"),
    }));
    const restoreLabels = () => {
      for (const record of originalPositions) {
        record.element.setAttribute("x", record.x);
        record.element.setAttribute("y", record.y);
      }
    };

    try {
      const records = labelElements.map((element, index) => {
        const pointX = Number(element.dataset.pointX);
        const pointY = Number(element.dataset.pointY);
        const anchorX = Number(element.getAttribute("x"));
        const anchorY = Number(element.getAttribute("y"));
        const box = element.getBBox();
        return {
          element,
          index,
          pointX,
          pointY,
          width: box.width,
          height: box.height,
          anchorOffsetX: box.x + box.width / 2 - anchorX,
          anchorOffsetY: box.y + box.height / 2 - anchorY,
          placement: null,
        };
      });
      const invalidRecord = records.some((record) => !(
        Number.isFinite(record.pointX)
        && Number.isFinite(record.pointY)
        && Number.isFinite(record.width)
        && record.width > 0
        && Number.isFinite(record.height)
        && record.height > 0
      ));
      if (invalidRecord) {
        restoreLabels();
        return undefined;
      }

      for (const record of records) {
        record.placement = _getLabelPlacement(
          record,
          EXPORT_LABEL_DEFAULT_ANGLE,
        );
      }
      const optimizationOrder = [...records].sort((first, second) => (
        _getLabelDensity(second, records)
          - _getLabelDensity(first, records)
        || first.index - second.index
      ));

      for (let pass = 0; pass < EXPORT_LABEL_MAX_PASSES; pass += 1) {
        let changed = false;
        for (const record of optimizationOrder) {
          const placement = _findBestLabelPlacement(record, records, bounds);
          if (
            _getAngleDifference(
              placement.angle,
              record.placement.angle,
            ) > 0.05
          ) {
            changed = true;
          }
          record.placement = placement;
        }
        if (!changed) {
          break;
        }
      }

      for (const record of records) {
        record.element.setAttribute("x", String(record.placement.x));
        record.element.setAttribute("y", String(record.placement.y));
      }
      return restoreLabels;
    } catch (error) {
      restoreLabels();
      globalScope.console?.warn(
        "Could not optimize cost scatter labels; using defaults.",
        error,
      );
      return undefined;
    }
  }

  /** @description Render the replay SVG directly so nested SVG content is preserved */
  async function _replaySvgToPng(root, width, pixelRatio, backgroundColor) {
    const sourceSvg = root.querySelector(":scope > svg");
    if (!sourceSvg) {
      throw new Error("Replay SVG is unavailable");
    }
    const clone = sourceSvg.cloneNode(true);
    const sourceElements = [sourceSvg, ...sourceSvg.querySelectorAll("*")];
    const cloneElements = [clone, ...clone.querySelectorAll("*")];
    const copiedProperties = [
      "display",
      "fill",
      "fill-opacity",
      "filter",
      "opacity",
      "stroke",
      "stroke-dasharray",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-opacity",
      "stroke-width",
      "vector-effect",
      "visibility",
    ];
    sourceElements.forEach((source, index) => {
      const computed = getComputedStyle(source);
      for (const property of copiedProperties) {
        cloneElements[index].style.setProperty(
          property,
          computed.getPropertyValue(property),
        );
      }
    });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(width));

    const serialized = new XMLSerializer().serializeToString(clone);
    const blobUrl = URL.createObjectURL(new Blob(
      [serialized],
      { type: "image/svg+xml;charset=utf-8" },
    ));
    try {
      const image = await _loadImage(blobUrl);
      const canvas = document.createElement("canvas");
      canvas.width = width * pixelRatio;
      canvas.height = width * pixelRatio;
      const context = canvas.getContext("2d");
      context.scale(pixelRatio, pixelRatio);
      context.fillStyle = backgroundColor;
      context.fillRect(0, 0, width, width);
      context.drawImage(image, 0, 0, width, width);
      context.fillStyle = globalScope.MazeBenchTheme?.getTheme() === "dark"
        ? "#9CA3AF"
        : "#8A93A4";
      context.font = "700 20px Segoe UI, sans-serif";
      context.textAlign = "right";
      context.textBaseline = "top";
      context.fillText("Github/hehee9", width - 24, 22);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  /** @description Export one rendered visualization and restore its live layout */
  async function exportPng(root, {
    filename = "maze-bench-export.png",
    exportWidth = DEFAULT_EXPORT_WIDTH,
    pixelRatio = DEFAULT_PIXEL_RATIO,
  } = {}) {
    if (!(root instanceof globalScope.HTMLElement)) {
      throw new TypeError("A rendered dashboard element is required");
    }
    if (typeof globalScope.htmlToImage?.toPng !== "function") {
      throw new Error("html-to-image is unavailable");
    }

    const originalRootStyle = {
      width: root.style.width,
      minWidth: root.style.minWidth,
      maxWidth: root.style.maxWidth,
    };
    const originalTheme = root.getAttribute("data-theme");
    const overflowElements = [
      root,
      ...root.querySelectorAll(
        ".chart-horizontal-scroll, .full-heatmap-scroll, .heatmap-scroll, .table-scroll",
      ),
    ];
    const overflowRecords = overflowElements.map((element) => ({
      element,
      overflow: element.style.overflow,
      overflowX: element.style.overflowX,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      width: element.style.width,
      maxWidth: element.style.maxWidth,
    }));
    const showElements = [...root.querySelectorAll("[data-export-show='true']")];
    const showRecords = showElements.map((element) => ({
      element,
      style: element.getAttribute("style"),
    }));
    const svgStyleRecords = [];
    const sanitizedAttributes = [];
    let restorePreparedExport;
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(attribute.value)) {
          continue;
        }
        sanitizedAttributes.push({
          element,
          name: attribute.name,
          value: attribute.value,
        });
        element.setAttribute(
          attribute.name,
          attribute.value.replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
            "-",
          ),
        );
      }
    }

    try {
      root.dataset.exporting = "true";
      root.dataset.theme = globalScope.MazeBenchTheme?.getTheme() ?? "light";
      root.style.width = `${exportWidth}px`;
      root.style.minWidth = root.style.width;
      root.style.maxWidth = "none";
      for (const record of overflowRecords) {
        record.element.style.overflow = "visible";
        record.element.style.overflowX = "visible";
        record.element.style.maxWidth = "none";
        record.element.scrollLeft = 0;
        record.element.scrollTop = 0;
      }
      for (const record of showRecords) {
        record.element.style.display = "block";
      }
      await _nextFrame();
      await _nextFrame();

      const expandedWidth = Math.max(exportWidth, root.scrollWidth);
      if (expandedWidth > exportWidth) {
        root.style.width = `${expandedWidth}px`;
        root.style.minWidth = root.style.width;
        await _nextFrame();
      }
      restorePreparedExport = _prepareCostScatterLabels(root);

      for (const element of root.querySelectorAll("svg, svg *")) {
        const computed = getComputedStyle(element);
        svgStyleRecords.push({
          element,
          style: element.getAttribute("style"),
        });
        const copiedProperties = [
          "fill",
          "stroke",
          "stroke-width",
          "vector-effect",
        ];
        if (element.matches(".scatter-export-label")) {
          copiedProperties.push(
            "font-family",
            "font-size",
            "font-weight",
            "letter-spacing",
            "text-anchor",
          );
        }
        for (const property of copiedProperties) {
          element.style.setProperty(property, computed.getPropertyValue(property));
        }
      }

      const width = Math.max(exportWidth, root.scrollWidth);
      const height = root.scrollHeight;
      const backgroundColor = globalScope.MazeBenchTheme?.getTheme() === "dark"
        ? "#111827"
        : "#ffffff";
      const dataUrl = root.classList.contains("maze-stage")
        ? await _replaySvgToPng(root, width, pixelRatio, backgroundColor)
        : await globalScope.htmlToImage.toPng(root, {
          backgroundColor,
          cacheBust: true,
          filter: (node) => node.dataset?.exportHide !== "true",
          height,
          pixelRatio,
          skipAutoScale: false,
          width,
        });
      const link = globalScope.document.createElement("a");
      link.download = _sanitizeFilename(filename);
      link.href = dataUrl;
      link.click();
      _setStatus("success", "export.saved");
      return link.download;
    } catch (error) {
      _setStatus("error", "export.failed");
      throw error;
    } finally {
      restorePreparedExport?.();
      delete root.dataset.exporting;
      if (originalTheme === null) {
        root.removeAttribute("data-theme");
      } else {
        root.setAttribute("data-theme", originalTheme);
      }
      root.style.width = originalRootStyle.width;
      root.style.minWidth = originalRootStyle.minWidth;
      root.style.maxWidth = originalRootStyle.maxWidth;
      for (const record of overflowRecords) {
        record.element.style.overflow = record.overflow;
        record.element.style.overflowX = record.overflowX;
        record.element.scrollLeft = record.scrollLeft;
        record.element.scrollTop = record.scrollTop;
        record.element.style.width = record.width;
        record.element.style.maxWidth = record.maxWidth;
      }
      for (const record of svgStyleRecords) {
        if (record.style === null) {
          record.element.removeAttribute("style");
        } else {
          record.element.setAttribute("style", record.style);
        }
      }
      for (const record of showRecords) {
        if (record.style === null) {
          record.element.removeAttribute("style");
        } else {
          record.element.setAttribute("style", record.style);
        }
      }
      for (const record of sanitizedAttributes) {
        record.element.setAttribute(record.name, record.value);
      }
    }
  }

  /** @description Bind every declarative export button in one document */
  function bindDocument(root = globalScope.document) {
    if (!root?.querySelectorAll) {
      return;
    }
    for (const button of root.querySelectorAll("[data-export-target]")) {
      if (button.dataset.exportBound === "true") {
        continue;
      }
      button.dataset.exportBound = "true";
      button.addEventListener("click", async () => {
        const target = globalScope.document.querySelector(
          button.dataset.exportTarget,
        );
        if (!target) {
          _setStatus("error", "export.failed");
          return;
        }
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        try {
          await exportPng(target, {
            filename: button.dataset.exportFilename,
            exportWidth: button.dataset.exportWidth === "current"
              ? Math.ceil(target.getBoundingClientRect().width)
              : undefined,
          });
        } catch (error) {
          globalScope.console?.error("Image export failed:", error);
        } finally {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
    }
  }

  const api = {
    DEFAULT_EXPORT_WIDTH,
    DEFAULT_PIXEL_RATIO,
    EXPORT_EVENT,
    bindDocument,
    exportPng,
  };

  globalScope.MazeBenchImageExport = api;
  globalScope.addEventListener?.("DOMContentLoaded", () => bindDocument());
}(globalThis));
