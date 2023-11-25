import moment from "moment";
import { Bridge } from "./bridgestuff/Bridge";
import { Settings } from "./settings/Settings";
import { Logger } from "./Logger";
import path from "path";
import fs from "fs";

type Direction = "d2t" | "t2d";

const MAX_32_BIT = 0x7fffffff;

const digRow = (map: Map<string, Map<string, Set<string>>>, keys: string[], value: string): any => {
	const [bridgeName, exchangeId] = keys;
	const bridge: Map<string, Set<string>> = map.get(bridgeName) || new Map<string, Set<string>>();
	const exchange: Set<string> = bridge.get(exchangeId) || new Set<string>();
	exchange.add(value);
	bridge.set(exchangeId, exchange);
	map.set(bridgeName, bridge);
};

const loadFile = (filename: string): Map<string, Map<string, Set<string>>> => {
	const map: Map<string, Map<string, Set<string>>> = new Map();
	const fileContent: string = fs.readFileSync(filename, "utf-8");

	fileContent.split("\n").forEach(line => {
		const cols = line.split(",");
		if (cols.length < 4) {
			return;
		}
		let secondKey = "";
		let value = "";
		if (cols[2] === ">") {
			secondKey = `t2d ${cols[1].trim()}`;
			value = cols[3].trim();
		} else if (cols[2] === "<") {
			secondKey = `d2t ${cols[3].trim()}`;
			value = cols[1].trim();
		}

		digRow(map, [cols[0], secondKey], value);
	});

	return map;
};

/** Handles mapping between message IDs in discord and telegram, for message editing purposes */
export class MessageMap {
	private _map: Map<string, Map<string, Set<string>>>;
	private _db_path: any = null;
	private _fh: number = 0;
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
			this._fh = fs.openSync(this._db_path, "a");

			// Convert dictionary into Map
			this._map = loadFile(this._db_path);

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

		let arrow: string = "";
		let from: string = "";
		let to: string = "";
		if (direction === "t2d") {
			arrow = ">";
			from = fromId;
			to = toId;
		} else if (direction === "d2t") {
			arrow = "<";
			from = toId;
			to = fromId;
		} else {
			this._logger.error("Unable to determine direction");
		}

		// Write new line to csv
		fs.writeFileSync(this._fh, `${bridge.name},${from},${arrow},${to}\n`);

		// Start a timeout removing it again after a configured amount of time. Default is 24 hours
		safeTimeout(() => {
			if (keyToIdsMap) {
				keyToIdsMap.delete(key);
			}
		}, moment.duration(this._messageTimeoutAmount, this._messageTimeoutUnit).asMilliseconds());
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
