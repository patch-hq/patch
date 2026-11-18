// Whole-chat drag-and-drop attach (spec/14 § Composer — dropping a file
// anywhere over the chat panel attaches it, not just onto the composer strip
// itself; Todoist 6hfg48wcWx2j7vxc — "dropzone of whole chat"). Same depth-
// counter shape as the composer's own drag handling (dragenter/dragleave fire
// on every child crossed), applied to the panel that WRAPS the composer. The
// composer's own handlers `stopPropagation()`, so while the pointer is over
// the composer itself this hook's counter holds still and the composer's own
// (identical-looking) overlay takes over — see Composer.tsx's onDragEnter.

import type { RefObject } from 'react';
import { useState } from 'react';
import { getDesktopBridge } from './desktopBridge.js';
import {
  dragHasFiles,
  filesFromDataTransfer,
  type ComposerHandle,
} from '../components/Composer.js';

export interface WholeChatDropZone {
  dragActive: boolean;
  dropBlocked: boolean;
  handlers: {
    onDragEnter(e: React.DragEvent): void;
    onDragOver(e: React.DragEvent): void;
    onDragLeave(e: React.DragEvent): void;
    onDrop(e: React.DragEvent): void;
  };
}

/** The real paths of the folders in a drop, read synchronously (the drop's
 *  data is gone once the event returns). Empty in a browser, which cannot
 *  learn a path, so a dropped folder there is attached as files instead. */
export function droppedFolderPaths(dt: DataTransfer): string[] {
  const pathForFile = getDesktopBridge()?.pathForFile;
  if (!pathForFile) return [];
  const paths: string[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
    if (!item.webkitGetAsEntry()?.isDirectory) continue;
    const file = item.getAsFile();
    if (file) paths.push(pathForFile(file));
  }
  return paths;
}

export function useWholeChatDrop(
  composerRef: RefObject<ComposerHandle | null>,
  /** New chat only: a dropped folder is the chat's folder, not an attachment. */
  onFolderDrop?: (paths: string[]) => void,
): WholeChatDropZone {
  const [dragDepth, setDragDepth] = useState(0);
  const dropBlocked = composerRef.current?.isDropBlocked() ?? false;

  function onDragEnter(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  }
  function onDragOver(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dropBlocked ? 'none' : 'copy';
  }
  function onDragLeave(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  }
  function onDrop(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const dt = e.dataTransfer;
    if (onFolderDrop) {
      const folders = droppedFolderPaths(dt);
      if (folders.length > 0) {
        onFolderDrop(folders);
        return;
      }
    }
    void filesFromDataTransfer(dt).then((files) => composerRef.current?.attachFiles(files));
  }

  return {
    dragActive: dragDepth > 0,
    dropBlocked,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
