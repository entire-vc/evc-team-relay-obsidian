<script lang="ts">
	export let pillText: string;
	export let ariaLabel: string;
</script>

<div
	aria-label={ariaLabel}
	class="evc-relay-filepill nav-file-tag"
	style="white-space: nowrap;"
>{pillText}</div>
