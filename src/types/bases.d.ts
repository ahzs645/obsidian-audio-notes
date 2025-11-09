import "obsidian";

declare module "obsidian" {
	interface Plugin {
		registerBasesView(
			viewType: string,
			options: {
				name: string;
				icon: string;
				factory: (
					controller: QueryController,
					containerEl: HTMLElement
				) => BasesView;
				options?: () => ViewOption[];
			}
		): void;
	}

	type BasesPropertyId = string;

	interface ViewOption {
		displayName: string;
		type: string;
		key?: string;
		placeholder?: string;
		default?: string;
		items?: ViewOption[];
		options?: Record<string, string>;
	}

	interface QueryController {
		requestRerun?: () => void;
	}

	interface BasesEntry {
		file: TFile;
		getValue: (propId: BasesPropertyId) => unknown;
	}

	class BasesView extends Component {
		constructor(controller: QueryController);
		type: string;
		config: {
			get(key: string): unknown;
			getAsPropertyId(key: string): BasesPropertyId | null;
			getOrder(): BasesPropertyId[] | null;
		};
		data?:
			| {
					data: BasesEntry[];
			  }
			| undefined;
		onDataUpdated(): void;
		onResize?(): void;
	}
}
