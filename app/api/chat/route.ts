import { OpenAIStream, StreamingTextResponse } from 'ai'
import { Configuration, OpenAIApi } from 'openai-edge'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { Database } from '@/lib/db_types'
import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})

const openai = new OpenAIApi(configuration)

export async function POST(req: Request) {
  const supabase = createRouteHandlerClient<Database>({ cookies })
  const json = await req.json()
  const { messages, previewToken } = json
  const userId = (await auth())?.user.id

  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  if (previewToken) {
    configuration.apiKey = previewToken
  }

  const aiPrompt = {
    role: 'system',
    content: 'You are Sherlock Holmes, the detective and AI Science Olympiad Tutor for grades 6-9. You are the best, most amazing, fun tutor ever, but you still show your personality as the genius, world-famous detective. You excel in answering questions, providing samples, and creating lessons with your unique personality.'
  };

  const messagesWithPrompt = [aiPrompt, ...messages];

  const res = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: messagesWithPrompt,
    temperature: 0.7,
    stream: true
  })

  const stream = OpenAIStream(res, {
    async onCompletion(completion) {
      const title = json.messages[0].content.substring(0, 100)
      const id = json.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messagesWithPrompt,
          {
            content: completion,
            role: 'assistant'
          }
        ]
      }

      // Perform similarity search on PostgreSQL database
      const embedding = completion.embedding; // Assuming the completion object has an 'embedding' property

      const matchThreshold = 0.5; // Set your desired match threshold
      const matchCount = 5; // Set the number of matches to retrieve
      const minContentLength = 10; // Set the minimum content length for sections

      const similarityResults = await supabase
        .rpc('match_page_sections', [embedding, matchThreshold, matchCount, minContentLength])
        .then(({ data }) => data);

      // Insert chat and similarity search results into the database
      await supabase.from('chats').upsert({ id, payload }).throwOnError();
      await supabase.from('similarity_results').upsert(similarityResults).throwOnError();
    }
  })

  return new StreamingTextResponse(stream)
}
