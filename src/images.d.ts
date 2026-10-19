// esbuild bundles image imports as base64 data URLs (loader: { ".png": "dataurl" },
// esbuild.config.mjs). TS has no built-in type for that -- without this declaration
// `import evcLogo from "../assets/evc-logo.png"` fails to type-check even though it
// builds and runs fine.
declare module "*.png" {
	const src: string;
	export default src;
}
