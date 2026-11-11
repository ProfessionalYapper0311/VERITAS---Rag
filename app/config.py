from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings): ##centralized config, have entire access to .env vars
    model_config=SettingsConfigDict(env_file = ".env", extra= "ignore")
    aws_region:str = "us-east-1"
    aws_access_key_id:str = ''
    aws_secret_access_key:str = ''
    aws_session_token:str = '' #optional temp aws cred
    s3_bucket:str = ''
    database_url:str = ''
    bedrock_embed_model:str = 'amazon.titan-embed-text-v2:0'
    bedrock_chat_model:str = 'amazon.nova-lite-v1:0'
    embed_dimension:int = 1024
    max_upload_bytes:int = 10485760 #10MB - user uploadding pdf etc. 
    pinecone_api_key:str = ''
    pinecone_index_name:str = 'veritas--rag-index'
    pinecone_cloud:str= 'aws'
    pinecone_region:str= 'us-east-1'
    pinecone_ready_timeout:int= 180
    min_relevance:float= 0.25
    hitl_enabled:bool= True
    memory_turns:int= 6


@lru_cache() 
def get_settings() -> Settings:
    return Settings()