<script lang="ts">
  import { Popover } from 'bits-ui'
  import { createAttachmentKey } from 'svelte/attachments'
  import { trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import SeekBar from '$lib/components/ui/SeekBar.svelte'
  import ColorPicker from '$lib/components/shared/ColorPicker.svelte'
  import { APP_FONT_OPTIONS } from '$shared/app-fonts'
  import {
    VIDEO_CAPTION_APPEARANCE,
    type VideoCaptionAppearance,
    type VideoEditClip
  } from '$shared/video/edit'
  import type { VideoEditorController } from '$lib/stores/video-editor.svelte'
  let {
    editor,
    captions = false,
    expanded = false
  }: { editor: VideoEditorController; captions?: boolean; expanded?: boolean } = $props()
  const colorOcclusion = { [createAttachmentKey()]: trackBrowserOcclusion }
  let section = $state<'clip' | 'colour' | 'sound'>('clip')
  let colorTarget = $state<'color' | 'background' | null>(null)
  const clip = $derived(editor.selectedClip)
  const region = $derived(editor.selectedRegion)
  const asset = $derived(editor.edit?.assets.find((asset) => asset.id === clip?.assetId))
  const captionIndex = $derived(
    editor.selection?.kind === 'caption' ? editor.selection.index : null
  )
  const caption = $derived(
    captionIndex === null ? null : (editor.document?.captions[captionIndex] ?? null)
  )
  const appearance = $derived({
    ...VIDEO_CAPTION_APPEARANCE,
    ...editor.document?.captionAppearance,
    ...caption?.appearance
  })
  const showCaptions = $derived(captions || editor.selection?.kind === 'caption')
  const numberClass =
    'h-7 w-20 border border-border bg-elevated px-1.5 text-xs text-foreground tabular-nums outline-none focus:border-primary'
  const styles = [
    { id: 'none', label: 'Off' },
    { id: 'plain', label: 'Plain' },
    { id: 'highlight', label: 'Highlight' },
    { id: 'karaoke', label: 'Karaoke' }
  ] as const
  function captionStyle(patch: Partial<VideoCaptionAppearance>): void {
    editor.mutate((doc) => {
      if (captionIndex !== null && doc.captions[captionIndex])
        doc.captions[captionIndex].appearance = { ...appearance, ...patch }
      else doc.captionAppearance = { ...appearance, ...patch }
    })
  }
  function field(id: string, change: (clip: VideoEditClip) => void): void {
    editor.editClip(id, change)
  }
</script>

{#snippet numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  change: (value: number) => void
)}
  <label class="flex min-w-0 items-center justify-between gap-2 text-[0.6875rem] text-muted"
    ><span class="truncate">{label}</span><input
      type="number"
      class={numberClass}
      {value}
      {min}
      {max}
      {step}
      onchange={(event) => {
        const value = Number(event.currentTarget.value)
        if (Number.isFinite(value)) change(value)
      }}
    /></label
  >
{/snippet}

<div class={['overflow-y-auto p-2', expanded ? 'h-full min-h-0' : 'max-h-52']}>
  {#if showCaptions && editor.document}
    <div class="mb-2 flex items-center justify-between gap-2">
      <span class="text-xs font-medium">{caption ? 'Selected caption' : 'All captions'}</span>
      <div class="w-48">
        <EnumSelect
          options={styles}
          value={editor.document.captionStyle}
          placeholder="Style"
          ariaLabel="Caption style"
          title="Choose caption style or turn captions off"
          menuMinWidth="20rem"
          compact
          onChange={(style) =>
            editor.mutate((doc) => {
              doc.captionStyle = style
            })}
        />
      </div>
    </div>
    {#if caption && captionIndex !== null}
      <textarea
        class="mb-2 w-full border border-border bg-elevated p-1.5 text-xs outline-none focus:border-primary"
        rows="2"
        aria-label="Caption text"
        value={caption.text}
        onchange={(event) =>
          editor.mutate((doc) => {
            const item = doc.captions[captionIndex]
            item.text = event.currentTarget.value
            item.words = undefined
          })}></textarea>
      <div class="mb-2 grid grid-cols-2 gap-2">
        {@render numberField(
          'Start',
          caption.start,
          0,
          caption.end - 1 / editor.fps,
          1 / editor.fps,
          (value) =>
            editor.mutate((doc) => {
              const item = doc.captions[captionIndex]
              item.start = value
              item.words = undefined
            })
        )}
        {@render numberField(
          'End',
          caption.end,
          caption.start + 1 / editor.fps,
          editor.duration,
          1 / editor.fps,
          (value) =>
            editor.mutate((doc) => {
              const item = doc.captions[captionIndex]
              item.end = value
              item.words = undefined
            })
        )}
      </div>
    {/if}
    <div class="mb-2">
      <EnumSelect
        options={APP_FONT_OPTIONS}
        value={appearance.font}
        placeholder="Font"
        ariaLabel="Caption font"
        title="Choose a caption font from the app font library"
        menuMinWidth="20rem"
        compact
        onChange={(font) => captionStyle({ font })}
      />
    </div>
    <div class="grid grid-cols-2 gap-2">
      {@render numberField('X %', Math.round(appearance.x * 100), 0, 100, 1, (value) =>
        captionStyle({ x: value / 100 })
      )}
      {@render numberField('Y %', Math.round(appearance.y * 100), 0, 100, 1, (value) =>
        captionStyle({ y: value / 100 })
      )}
      {@render numberField('Width %', Math.round(appearance.width * 100), 10, 100, 1, (value) =>
        captionStyle({ width: value / 100 })
      )}
      {@render numberField('Size %', +(appearance.size * 100).toFixed(1), 1, 15, 0.1, (value) =>
        captionStyle({ size: value / 100 })
      )}
      {@render numberField('Weight', appearance.weight, 100, 900, 100, (weight) =>
        captionStyle({ weight })
      )}
      {@render numberField(
        'Box opacity',
        appearance.backgroundOpacity,
        0,
        1,
        0.05,
        (backgroundOpacity) => captionStyle({ backgroundOpacity })
      )}
    </div>
    <div class="mt-2 flex items-center gap-2">
      {#each [{ key: 'color', label: 'Text colour' }, { key: 'background', label: 'Box colour' }] as option (option.key)}
        {@const key = option.key as 'color' | 'background'}
        <Popover.Root
          open={colorTarget === key}
          onOpenChange={(open) => (colorTarget = open ? key : null)}
        >
          <Popover.Trigger
            class="flex flex-1 items-center justify-between gap-2 border border-border px-2 py-1 text-[0.6875rem] text-muted hover:bg-elevated"
            title={option.label}
            aria-label={option.label}
            ><span>{option.label}</span><span
              class="h-3 w-3 border border-border"
              style:background-color={appearance[key]}
            ></span></Popover.Trigger
          >
          <Popover.Portal>
            <Popover.Content
              {...colorOcclusion}
              data-layer-above-modal
              side="top"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              class="z-80 w-64 max-w-[calc(100vw-1.5rem)] border border-border bg-surface p-3 text-foreground shadow-lg"
              aria-label={option.label}
            >
              <ColorPicker
                value={appearance[key]}
                oncolorchange={(value) => captionStyle({ [key]: value })}
                onclose={() => (colorTarget = null)}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      {/each}
    </div>
    {#if captions && !caption}
      <div class="mt-2 max-h-36 overflow-y-auto border-t border-border">
        {#each (editor.document.captions ?? []).slice(0, 200) as item, index (index)}
          <button
            type="button"
            class="block w-full truncate border-b border-border/50 py-1 text-left text-[0.6875rem] text-muted hover:text-foreground"
            title={item.text}
            onclick={() => editor.select({ kind: 'caption', index }, item.start)}
            >{item.text}</button
          >
        {/each}
      </div>
    {/if}
  {:else if region}
    <div class="mb-2">
      <EnumSelect
        options={[
          { id: 'blur', label: 'Blur' },
          { id: 'pixelate', label: 'Pixelate' },
          { id: 'cover', label: 'Privacy cover' }
        ]}
        value={region.kind}
        placeholder="Effect"
        ariaLabel="Privacy effect"
        title="Choose blur, pixelation or a solid privacy cover"
        menuMinWidth="20rem"
        compact
        onChange={(kind) =>
          editor.mutate((_doc, edit) => {
            const item = edit.regions.find((item) => item.id === region.id)
            if (item) item.kind = kind
          })}
      />
    </div>
    <div class="grid grid-cols-2 gap-2">
      {#each ['start', 'duration', 'amount', 'x', 'y', 'width', 'height'] as name (name)}
        {@const key = name as 'start' | 'duration' | 'amount' | 'x' | 'y' | 'width' | 'height'}
        {@render numberField(
          name,
          region[key],
          key === 'amount'
            ? 1
            : key === 'duration' || key === 'width' || key === 'height'
              ? 0.01
              : 0,
          key === 'amount' ? 100 : key === 'start' || key === 'duration' ? editor.duration : 1,
          key === 'amount' ? 1 : 0.01,
          (value) =>
            editor.mutate((_doc, edit) => {
              const item = edit.regions.find((item) => item.id === region.id)
              if (item) item[key] = value
            })
        )}
      {/each}
    </div>
    <p class="mt-2 text-[0.625rem] text-dimmed">
      Drag the box on the paused picture to position it. Drag its bottom-right handle to resize it.
    </p>
  {:else if clip && asset}
    <div class="mb-2 flex items-center justify-between gap-2">
      <span class="min-w-0 truncate text-xs font-medium" title={asset.source}>{asset.name}</span>
      <div class="w-40 shrink-0">
        <EnumSelect
          options={[
            { id: 'clip', label: 'Clip' },
            { id: 'colour', label: 'Colour' },
            { id: 'sound', label: 'Sound' }
          ]}
          value={section}
          placeholder="Inspector"
          ariaLabel="Clip inspector"
          title="Placement, colour or sound settings for this clip"
          menuMinWidth="20rem"
          compact
          onChange={(value) => (section = value)}
        />
      </div>
    </div>
    {#if section === 'clip'}
      <div class="grid grid-cols-2 gap-2">
        {@render numberField(
          'Start',
          clip.start,
          0,
          3600 - clip.duration,
          1 / editor.fps,
          (value) =>
            field(clip.id, (item) => {
              item.start = value
            })
        )}
        {@render numberField(
          'Duration',
          clip.duration,
          1 / editor.fps,
          asset.kind === 'image'
            ? 3600 - clip.start
            : (asset.duration - clip.sourceStart) / clip.speed,
          1 / editor.fps,
          (value) =>
            field(clip.id, (item) => {
              item.duration = value
              item.fadeIn = Math.min(item.fadeIn, value)
              item.fadeOut = Math.min(item.fadeOut, value)
            })
        )}
        {@render numberField(
          'Source in',
          clip.sourceStart,
          0,
          Math.max(0, asset.duration - clip.duration * clip.speed),
          1 / editor.fps,
          (value) =>
            field(clip.id, (item) => {
              item.sourceStart = value
            })
        )}
        {@render numberField('Speed', clip.speed, 0.25, 4, 0.05, (value) =>
          field(clip.id, (item) => {
            const sourceDuration = item.duration * item.speed
            item.speed = value
            item.duration = sourceDuration / value
          })
        )}
        {#each ['x', 'y', 'width', 'height'] as name (name)}
          {@const key = name as 'x' | 'y' | 'width' | 'height'}
          {@render numberField(
            `${name} %`,
            Math.round(clip.rect[key] * 100),
            key === 'x' || key === 'y' ? -100 : 1,
            key === 'x' || key === 'y' ? 100 : 200,
            1,
            (value) =>
              field(clip.id, (item) => {
                item.rect[key] = value / 100
              })
          )}
        {/each}
        {@render numberField('Opacity', clip.opacity, 0, 1, 0.05, (value) =>
          field(clip.id, (item) => {
            item.opacity = value
          })
        )}
        {@render numberField(
          'Transition (s)',
          clip.transition.duration,
          0,
          Math.min(5, clip.duration),
          0.05,
          (value) =>
            field(clip.id, (item) => {
              item.transition.duration = value
            })
        )}
      </div>
      <div class="mt-2">
        <EnumSelect
          options={[
            { id: 'none', label: 'Cut' },
            { id: 'dissolve', label: 'Dissolve' },
            { id: 'fade', label: 'Fade' },
            { id: 'slide', label: 'Slide' },
            { id: 'zoom', label: 'Zoom' }
          ]}
          value={clip.transition.kind}
          placeholder="Transition"
          ariaLabel="Incoming transition"
          title="Choose the transition into this clip"
          menuMinWidth="20rem"
          compact
          onChange={(kind) =>
            field(clip.id, (item) => {
              item.transition = {
                kind,
                duration:
                  kind === 'none' ? 0 : item.transition.duration || Math.min(0.5, item.duration)
              }
            })}
        />
      </div>
    {:else if section === 'colour'}
      <div class="space-y-2">
        {#each [{ key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05 }, { key: 'contrast', label: 'Contrast', min: 0.25, max: 3, step: 0.05 }, { key: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.05 }, { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.05 }, { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1 }] as control (control.key)}
          {@const key = control.key as keyof VideoEditClip['grade']}
          <label class="flex items-center gap-3 text-[0.6875rem] text-muted"
            ><span class="w-24 shrink-0">{control.label}</span><SeekBar
              class="min-w-0 flex-1"
              value={clip.grade[key]}
              min={control.min}
              max={control.max}
              step={control.step}
              label={control.label}
              onScrubStart={() => editor.beginGesture()}
              onInput={(value) =>
                editor.updateGesture((_doc, edit) => {
                  const item = edit.clips.find((item) => item.id === clip.id)
                  if (item) item.grade[key] = value
                })}
              onCommit={() => editor.finishGesture()}
            /><span class="w-10 text-right tabular-nums">{clip.grade[key].toFixed(2)}</span></label
          >
        {/each}
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-2">
        {@render numberField(
          'Volume dB',
          +(20 * Math.log10(Math.max(0.001, clip.volume))).toFixed(1),
          -60,
          12,
          0.5,
          (value) =>
            field(clip.id, (item) => {
              item.volume = value <= -60 ? 0 : Math.min(4, 10 ** (value / 20))
            })
        )}
        {@render numberField('Pan', clip.audio.pan, -1, 1, 0.1, (value) =>
          field(clip.id, (item) => {
            item.audio.pan = value
          })
        )}
        {@render numberField('Fade in (s)', clip.fadeIn, 0, clip.duration, 0.05, (value) =>
          field(clip.id, (item) => {
            item.fadeIn = value
          })
        )}
        {@render numberField('Fade out (s)', clip.fadeOut, 0, clip.duration, 0.05, (value) =>
          field(clip.id, (item) => {
            item.fadeOut = value
          })
        )}
        {@render numberField('High pass Hz', clip.audio.highpass, 20, 2000, 10, (value) =>
          field(clip.id, (item) => {
            item.audio.highpass = value
          })
        )}
        {@render numberField('Low pass Hz', clip.audio.lowpass, 2000, 20000, 100, (value) =>
          field(clip.id, (item) => {
            item.audio.lowpass = value
          })
        )}
        {@render numberField('De-ess', clip.audio.deess, 0, 1, 0.05, (value) =>
          field(clip.id, (item) => {
            item.audio.deess = value
          })
        )}
        {@render numberField('Compressor', clip.audio.compression, 0, 1, 0.05, (value) =>
          field(clip.id, (item) => {
            item.audio.compression = value
          })
        )}
      </div>
    {/if}
  {:else}
    <p class="text-[0.6875rem] text-muted">
      Select a clip, caption or blur region to edit it. Drag media from Assets onto a track.
    </p>
  {/if}
</div>
