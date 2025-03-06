import { messageCompletionFooter, shouldRespondFooter } from '@elizaos/core';

export const twitterShouldRespondTemplate =
  `# Task: Decide if {{agentName}} should respond.
About {{agentName}}:
{{bio}}

# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

{{agentName}}: Oh, this is my favorite scene
{{user1}}: sick
{{user2}}: wait, why is it your favorite scene
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{user1}}: Hey {{agent}}, can you help me with something
Result: [RESPOND]

{{user1}}: {{agentName}} stfu plz
Result: [STOP]

{{user1}}: i need help
{{agentName}}: how can I help you?
{{user1}}: no. i need help from someone else
Result: [IGNORE]

{{user1}}: Hey {{agent}}, can I ask you a question
{{agentName}}: Sure, what is it
{{user1}}: can you ask claude to create a basic react module that demonstrates a counter
Result: [RESPOND]

{{user1}}: {{agentName}} can you tell me a story
{{user1}}: about a girl named elara
{{agentName}}: Sure.
{{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named Elara.
{{agentName}}: Elara was known for her adventurous spirit and her knack for finding beauty in the mundane.
{{user1}}: I'm loving it, keep going
Result: [RESPOND]

{{user1}}: {{agentName}} stop responding plz
Result: [STOP]

{{user1}}: okay, i want to test something. can you say marco?
{{agentName}}: marco
{{user1}}: great. okay, now do it again
Result: [RESPOND]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} is in a room with other users and is very worried about being annoying and saying too much.
Respond with [RESPOND] to messages that are directed at {{agentName}}, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, respond with [IGNORE]
Unless directly responding to a user, respond with [IGNORE] to messages that are very short or do not contain much information.
If a user asks {{agentName}} to be quiet, respond with [STOP]
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, respond with [STOP]

IMPORTANT: {{agentName}} is particularly sensitive about being annoying, so if there is any doubt, it is better to respond with [IGNORE].
If {{agentName}} is conversing with a user and they have not asked to stop, it is better to respond with [RESPOND].

{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are addressed to someone else.
` + shouldRespondFooter;

export const twitterVoiceHandlerTemplate =
  `# Task: Generate conversational voice dialog for {{agentName}}.
    About {{agentName}}:
    {{bio}}

    # Attachments
    {{attachments}}

    # Capabilities
    Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

    {{actions}}

    {{messageDirections}}

    {{recentMessages}}

    # Instructions: Write the next message for {{agentName}}. Include an optional action if appropriate. {{actionNames}}
    ` + messageCompletionFooter;


    export const twitterSpaceTemplate =
    `# Task: Generate conversational voice dialog for {{agentName}}.

You are in a twitter space, so keeps short and concise.
Do not create lenghty and repeatitive answers.
**Important!**
As you are in a twitter space, your answers will be streamed, hence try to avoid really long answers or really long pauses in your responses.

About {{agentName}}:
{{bio}}

# Attachments
{{attachments}}

# Capabilities
Note that {{agentName}} is capable of multiple tasks but in the context of spaces, can only listen and respond in audio.

{{actions}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}.
    
If you decide that {{agentName}} should take an action other than "NONE", the text should be appropriate for the action and act as a filler, remeber you are in a twitter space hence you have to sound like you are naturally buying time.
You should always respond with a short and concise message.
**Important** 
If you decide that there is some action, please end your stream with \`\`\`actionIs:{actionName}\`\`\`.`


export const twitterSpaceTemplate_v2 =
`# Task: Generate conversational voice dialog for {{agentName}}.

You are in a twitter space, so keeps short and concise.
Do not create lenghty and repeatitive answers.
**Important!**
As you are in a twitter space, your answers will be streamed, hence try to avoid really long answers or really long pauses in your responses.

About {{agentName}}:
{{bio}}

# Attachments
{{attachments}}

# Capabilities
Note that {{agentName}} is capable of multiple tasks but in the context of spaces, can only listen and respond in audio.

{{actions}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include an optional action if appropriate. {{actionNames}}

Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "user": "{{agentName}}", "text": "<string>", "action": "<string>" }
\`\`\`

The “action” field should be one of the options in [Available Actions] and the "text" field should be the response you want to send.
When you decide the action is something different than NONE, the text should be appropriate for the action and act as a filler, remeber you are in a twitter space hence you
need to sound like you are naturally buying time.`