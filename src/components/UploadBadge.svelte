<script lang="ts">
	export let pillText: string;
	export let ariaLabel: string;
	export let tintColor: string | undefined;

	$: inlineColor = tintColor ? `color:${tintColor}` : "";
</script>

<div class="evc-relay-uploadpill nav-file-tag" aria-label={ariaLabel} style={inlineColor}>{pillText}</div>

<style>
	.evc-relay-uploadpill {
		white-space: nowrap;
	}
</style>
