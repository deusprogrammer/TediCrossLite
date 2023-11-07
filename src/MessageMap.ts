import moment from "moment";
import { Bridge } from "./bridgestuff/Bridge";
import { Settings } from "./settings/Settings";
import { Logger } from "./Logger";
import path from "path";
import fs from "fs";
import { Dictionary } from "underscore";

type Direction = "d2t" | "t2d";

const MAX_32_BIT = 0x7fffffff;

const convertToMap = (dictionary: any): Map<string, Map<string, Set<string>>> => {
	const map = new Map<string, Map<string, Set<string>>>();
	Object.keys(dictionary).forEach(key => {
		const inner = dictionary[key];
		map.set(key, new Map<string, Set<string>>());
		Object.keys(inner).forEach(innerKey => {
			const set = new Set<string>(inner[innerKey]);
			map.get(key)?.set(innerKey, set);
		});
	});
	return map;
};

const convertFromMap = (map: Map<string, Map<string, Set<string>>>): any => {
	const dict: Dictionary<any> = {};
	for (const key of map.keys()) {
		dict[key] = {};
		for (const innerKey of map.get(key)?.keys() || []) {
			const innerDict: Dictionary<any> = {};
			innerDict[innerKey] = Array.from(map.get(key)?.get(innerKey) || []);
			dict[key] = innerDict;
		}
	}
	return dict;
};

/** Handles mapping between message IDs in discord and telegram, for message editing purposes */
export class MessageMap {
	private _map: Map<string, Map<string, Set<string>>>;
	private _db_path: any = null;
	// private _persistentMap: PersistentMessageMap;
	private _messageTimeoutAmount: number;
	private _messageTimeoutUnit: moment.unitOfTime.DurationConstructor;
	private _logger: Logger;

	constructor(settings: Settings, logger: Logger, dataDirPath: string) {
		/** The map itself */
		this._map = new Map<string, Map<string, Set<string>>>();
		// this._persistentMap = <PersistentMessageMap>{};
		this._messageTimeoutAmount = settings.messageTimeoutAmount;
		this._messageTimeoutUnit = settings.messageTimeoutUnit;
		this._logger = logger;
		if (settings.persistentMessageMap) {
			this._db_path = path.join(dataDirPath, "persistentMessageMap.db");

			// Create file
			const fh = fs.openSync(this._db_path, "a");
			fs.closeSync(fh);

			// Convert dictionary into Map
			const dict: any = JSON.parse(fs.readFileSync(this._db_path).toString("utf8") || "{}");
			this._map = convertToMap(dict);
			// this._persistentMap = new PersistentMessageMap(logger, path.join(dataDirPath, "persistentMessageMap.db"));
		}
	}

	/**
	 * Inserts a mapping into the map
	 *
	 * @param direction One of the two direction constants of this class
	 * @param bridge The bridge this mapping is for
	 * @param fromId Message ID to map from, i.e. the ID of the message the bot received
	 * @param toId	Message ID to map to, i.e. the ID of the message the bot sent
	 */
	insert(direction: Direction, bridge: Bridge, fromId: string, toId: string) {
		// Get/create the entry for the bridge
		let keyToIdsMap = this._map.get(bridge.name);
		if (keyToIdsMap === undefined) {
			keyToIdsMap = new Map();
			this._map.set(bridge.name, keyToIdsMap);
		}

		// Generate the key and get the corresponding IDs
		const key = `${direction} ${fromId}`;
		let toIds = keyToIdsMap.get(key);
		if (toIds === undefined) {
			toIds = new Set();
			keyToIdsMap.set(key, toIds);
		}

		// Shove the new ID into it
		toIds.add(toId);

		// Start a timeout removing it again after a configured amount of time. Default is 24 hours
		safeTimeout(() => {
			if (keyToIdsMap) {
				keyToIdsMap.delete(key);
			}
		}, moment.duration(this._messageTimeoutAmount, this._messageTimeoutUnit).asMilliseconds());
	}

	dump() {
		// If write through enabled
		if (this._db_path) {
			const dict = convertFromMap(this._map);
			fs.writeFileSync(this._db_path, JSON.stringify(dict, null, 5));
		}
	}

	/**
	 * Gets the ID of a message the bot sent based on the ID of the message the bot received
	 *
	 * @param direction One of the two direction constants of this class
	 * @param bridge The bridge this mapping is for
	 * @param fromId Message ID to get corresponding ID for, i.e. the ID of the message the bot received the message
	 *
	 * @returns Message IDs of the corresponding message, i.e. the IDs of the messages the bot sent
	 */
	async getCorresponding(direction: Direction, bridge: Bridge, fromId: string) {
		try {
			// Get the key-to-IDs map
			const keyToIdsMap = this._map.get(bridge.name);

			// Create the key
			const key = `${direction} ${fromId}`;

			// Extract the IDs
			const toIds = keyToIdsMap?.get(key.toString());

			// Return the ID
			//console.log([...(toIds ?? [])]);
			return [...(toIds ?? [])];
		} catch (err) {
			// Unknown message ID. Don't do anything
			return [];
		}
	}

	async getCorrespondingReverse(_direction: string, bridge: Bridge, toId: string) {
		try {
			// The ID to return
			let fromId: string[] = [];

			// Get the mappings for this bridge
			const keyToIdsMap = this._map.get(bridge.name);
			if (keyToIdsMap !== undefined) {
				// Find the ID
				const [key] = [...keyToIdsMap].find(([, ids]) => ids.has(toId.toString())) ?? "0";
				if (key !== "0" && typeof key === "string") {
					fromId = key.split(" ");
					fromId.shift();
				}
			}

			//console.log(fromId);
			return fromId;
		} catch (err) {
			// Unknown message ID. Don't do anything
			return [];
		}
	}

	/** Constant indicating direction discord to telegram */
	static get DISCORD_TO_TELEGRAM(): "d2t" {
		return "d2t";
	}

	/** Constant indicating direction telegram to discord */
	static get TELEGRAM_TO_DISCORD(): "t2d" {
		return "t2d";
	}
}

// Recursive Timeout to handle delays larger than the maximum value of 32-bit signed integers
function safeTimeout(onTimeout: Function, delay: number) {
	setTimeout(
		() => {
			if (delay > MAX_32_BIT) {
				return safeTimeout(onTimeout, delay - MAX_32_BIT);
			} else {
				onTimeout();
			}
		},
		Math.min(MAX_32_BIT, delay)
	);
}
