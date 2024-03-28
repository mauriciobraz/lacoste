import {
	InteractionHandler,
	InteractionHandlerTypes,
} from "@sapphire/framework";

import { ApplyOptions } from "@sapphire/decorators";
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	CategoryChannel,
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits,
	User,
	time,
} from "discord.js";
import { z } from "zod";
import { ENVIRONMENT } from "$lib/env";
import { TicketStatus } from "@prisma/client";
import { EmbedColors } from "$lib/constants/discord";

const ActionData = z.object({
	id: z
		.string()
		.optional()
		.refine((value) => value && /^[a-f\d]{24}$/i.test(value), {
			message: "Invalid ObjectId",
		}),

	action: z.enum(["OpenDefault", "OpenPraise", "End"]),
});

type ActionData = z.infer<typeof ActionData>;

export const BASE_BUTTON_ID = "LCST::OmbudsmanInteractionHandler";
export const BASE_BUTTON_ID_REGEX = new RegExp(`^${BASE_BUTTON_ID}/`);

export function encodeButtonId(data: ActionData) {
	return `${BASE_BUTTON_ID}/${JSON.stringify(data)}`;
}

export const READ_PERMISSIONS = [
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.ReadMessageHistory,
];

export interface TicketsCreateOptions {
	/* The user to create the ticket for. */
	user: User;

	/* The reason for creating the ticket. */
	reason: string;
}

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button,
})
export class OmbudsmanInteractionHandler extends InteractionHandler {
	#ticketsCategory?: CategoryChannel;

	public override async parse(interaction: ButtonInteraction) {
		if (!interaction.customId.match(BASE_BUTTON_ID_REGEX)) {
			return this.none();
		}

		if (!interaction.inGuild()) {
			this.container.logger.warn(
				`[HireInteractionHandler#isAuthorized] ${interaction.user.tag} tried to perform an action in a DM.`,
			);

			return this.none();
		}

		const { id, action } = ActionData.parse(
			JSON.parse(interaction.customId.split("/")[1]),
		);

		return this.some({ id, action });
	}

	public override async run(
		interaction: ButtonInteraction<"cached" | "raw">,
		{ id, action }: ActionData,
	) {
		if (action === "OpenDefault" || action === "OpenPraise") {
			this.#ticketsCategory ??= (await this.container.client.channels.fetch(
				ENVIRONMENT.TICKETS_CATEGORY,
			)) as CategoryChannel;

			const ticketChannel = await this.#ticketsCategory.children.create({
				type: ChannelType.GuildText,
				name: `${interaction.user.username}-${Math.random()
					.toString(36)
					.substring(2, 6)}`,
				permissionOverwrites: [
					{ id: interaction.user.id, allow: READ_PERMISSIONS },
					{ id: this.#ticketsCategory.guildId, deny: READ_PERMISSIONS },
					{
						id: ENVIRONMENT.SECTORS_ROLES.DIRETORIA.id,
						allow: READ_PERMISSIONS,
					},
				],
			});

			const ticketMessage = await ticketChannel.send({
				content: "\u200B",
			});

			const ticket = await this.container.prisma.ticket.create({
				data: {
					reason: "AUTO",
					status: TicketStatus.Open,
					messageId: ticketMessage.id,
					channelId: ticketChannel.id,
					User: { connect: { discordId: interaction.user.id } },
				},
				select: {
					id: true,
				},
			});

			const closeTicketButton = new ButtonBuilder()
				.setCustomId(encodeButtonId({ id: ticket.id, action: "End" }))
				.setStyle(ButtonStyle.Danger)
				.setLabel("Approve");

			const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				closeTicketButton,
			);

			const ticketEmbed = new EmbedBuilder()
				.setColor(EmbedColors.Default)
				.setTitle("Ouvidoria")
				.setAuthor({
					name: interaction.user.tag,
					iconURL: interaction.user.displayAvatarURL(),
				})
				.setFooter({
					text: ticket.id,
				});

			await ticketMessage.edit({
				embeds: [ticketEmbed],
				components: [actionRow],
				content: `<@&${ENVIRONMENT.SECTORS_ROLES.DIRETORIA.id}> <@${interaction.user.id}>`,
				allowedMentions: {
					users: [interaction.user.id],
					roles: [ENVIRONMENT.SECTORS_ROLES.DIRETORIA.id],
				},
			});

			await interaction.reply({
				content: `Seu ticket foi criado com sucesso! Clique aqui: ${ticketChannel}`,
				ephemeral: true,
			});

			return;
		}

		if (id) await this.#end(interaction, id);
	}

	async #end(interaction: ButtonInteraction, id: string) {
		const ticket = await this.container.prisma.ticket.findUnique({
			where: { id },
		});

		if (!ticket) {
			await interaction.reply({
				content: "Ticket não encontrado.",
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.ticket.update({
			where: { id },
			data: { status: TicketStatus.Closed },
		});

		const ticketChannel = await this.container.client.channels.fetch(
			ticket.channelId,
		);

		if (!ticketChannel) {
			await interaction.reply({
				content: "||TK207|| Ticket não encontrado, contate o desenvolvedor.",
				ephemeral: true,
			});

			return;
		}

		if (!ticketChannel.isTextBased()) {
			await interaction.reply({
				content:
					"||TK216|| Ticket não é um canal de texto, contate o desenvolvedor.",
				ephemeral: true,
			});

			return;
		}

		const ticketMessages = await ticketChannel.messages.fetch({
			after: ticket.messageId,
		});

		const formattedTicketHistory = ticketMessages
			.map(
				(message) =>
					`[${message.author.id}/@${message.author.tag}]: ${message.content}`,
			)
			.join("\n");

		const notificationChannel = await this.container.client.channels.fetch(
			ENVIRONMENT.NOTIFICATION_CHANNELS.TICKETS,
		);

		if (notificationChannel?.isTextBased()) {
			await notificationChannel.send({
				embeds: [
					new EmbedBuilder()
						.setColor(EmbedColors.Default)
						.setTitle("Ticket encerrado")
						.setDescription(
							`Ticket encerrado por ${interaction.user}, os registros das mensagens estão anexadas abaixo.`,
						)
						.addFields([
							{
								name: "Participantes",
								value: [
									...new Set(ticketMessages.map((message) => message.author)),
								].join("\n"),
							},
							{
								name: "Criado Em",
								value: time(ticket.createdAt, "F"),
							},
						]),
				],
				files: [
					new AttachmentBuilder(
						Buffer.from(formattedTicketHistory, "utf-8").toString("base64"),
					).setName("history.txt"),
				],
			});
		}
	}
}